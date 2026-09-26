import {
  BoxRenderable,
  RenderableEvents,
  StyledText,
  TextareaRenderable,
  fg,
  type CliRenderer,
  type KeyBinding,
  type TextRenderable,
} from "@opentui/core";
import { pct } from "../ascii.js";
import { OPENCODE_EMPTY_BORDER, staticText, surface } from "./components.js";
import { promptMaxHeight } from "./layout.js";
import { activityFrame } from "./spinner.js";
import type { UiTheme } from "./theme.js";

export interface PromptEvents {
  /** The user pressed Enter. The orchestrator reads the text via commit(). */
  onSubmit(): void;
}

export interface PromptStatus {
  busy: boolean;
  /** Esc was pressed once: the hint escalates to "again to interrupt". */
  interruptArmed: boolean;
  contextUsed?: number;
  contextTotal?: number;
}

const SPINNER_INTERVAL_MS = 120;
const WRAP_COLUMNS = 80;
const PANEL_PADDING_TOP = 1;
const FOOTER_PADDING_TOP = 1;
const FOOTER_ROWS = FOOTER_PADDING_TOP + 1;
const BUSY_WORD = "thinking";
const UNKNOWN_CONTEXT = "--";
// Stand-in for the terminal height until the orchestrator reports the real one.
const DEFAULT_MAX_HEIGHT = promptMaxHeight(40);

// OpenTUI hashes a binding as name+ctrl+shift+meta+super only, so an `alt`
// entry collapses onto the plain `return` slot. Alt+Return still resolves to
// newline because both entries map to the same action.
type TextareaKeyBinding = KeyBinding & { alt?: boolean };

const NEWLINE_KEY_BINDINGS: TextareaKeyBinding[] = [
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", alt: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatContextCompact(used?: number, total?: number): string {
  const knownTotal =
    total !== undefined && Number.isFinite(total) && total > 0 ? total : undefined;
  if (used === undefined || !Number.isFinite(used)) {
    return knownTotal === undefined ? "" : formatCount(knownTotal);
  }
  if (knownTotal === undefined) return formatCount(used);
  return `${formatCount(used)} (${pct(used / knownTotal)})`;
}

function bufferRows(text: string, maxRows: number): number {
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(Math.max(1, line.length) / WRAP_COLUMNS));
  }
  return Math.min(Math.max(1, rows), Math.max(1, maxRows));
}

export class PromptBox {
  readonly body: BoxRenderable;
  private readonly rule: BoxRenderable;
  private readonly panel: BoxRenderable;
  private readonly editor: TextareaRenderable;
  private readonly idleSlot: BoxRenderable;
  private readonly busySlot: BoxRenderable;
  private readonly hintText: TextRenderable;
  private readonly spinnerText: TextRenderable;
  private readonly rightText: TextRenderable;
  private maxHeight: number;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerTicks = 0;
  private status: PromptStatus = { busy: false, interruptArmed: false };

  constructor(
    private readonly renderer: CliRenderer,
    private readonly theme: UiTheme,
    private readonly events: PromptEvents,
  ) {
    this.body = surface(renderer, { id: "prompt-body", width: "100%", flexShrink: 0 });
    this.maxHeight = DEFAULT_MAX_HEIGHT;

    this.rule = surface(renderer, {
      id: "prompt-rule",
      width: "100%",
      focusedBorderColor: theme.accent,
      rule: { sides: ["left"], color: theme.border, bottomLeft: "╹" },
    });
    // BoxRenderable only honors focusedBorderColor when the box is focusable,
    // which is how a focused descendant tints the rule instead of the box.
    this.rule.focusable = true;
    this.body.add(this.rule);

    this.panel = surface(renderer, {
      id: "prompt-panel",
      backgroundColor: theme.element,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: PANEL_PADDING_TOP,
      flexShrink: 0,
      width: "100%",
    });
    this.panel.onMouseDown = () => {
      this.focus();
    };
    this.rule.add(this.panel);

    this.editor = new TextareaRenderable(renderer, {
      id: "prompt-editor",
      minHeight: 1,
      maxHeight: this.maxHeight,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
      wrapMode: "word",
      backgroundColor: theme.element,
      focusedBackgroundColor: theme.element,
      textColor: theme.text,
      focusedTextColor: theme.text,
      placeholderColor: theme.muted,
      cursorColor: theme.text,
      keyBindings: NEWLINE_KEY_BINDINGS,
      onSubmit: () => {
        this.events.onSubmit();
      },
      onContentChange: () => {
        this.refreshHeight();
      },
      onMouseDown: () => {
        this.focus();
      },
    });
    this.panel.add(this.editor);

    const footer = new BoxRenderable(renderer, {
      id: "prompt-footer",
      flexDirection: "row",
      justifyContent: "space-between",
      flexShrink: 0,
      paddingTop: FOOTER_PADDING_TOP,
    });
    this.panel.add(footer);

    this.idleSlot = new BoxRenderable(renderer, {
      id: "prompt-left-idle",
      flexDirection: "row",
      flexShrink: 0,
    });
    this.hintText = staticText(renderer, {
      id: "prompt-hint",
      content: "",
      fg: theme.muted,
      wrapMode: "none",
    });
    this.hintText.flexShrink = 0;
    this.idleSlot.add(this.hintText);
    footer.add(this.idleSlot);

    this.busySlot = new BoxRenderable(renderer, {
      id: "prompt-left-busy",
      flexDirection: "row",
      gap: 1,
      flexShrink: 0,
      visible: false,
    });
    this.spinnerText = staticText(renderer, {
      id: "prompt-spinner",
      content: "",
      fg: theme.text,
      wrapMode: "none",
    });
    this.busySlot.add(this.spinnerText);
    this.busySlot.add(
      staticText(renderer, {
        id: "prompt-busy-word",
        content: BUSY_WORD,
        fg: theme.muted,
        wrapMode: "none",
      }),
    );
    footer.add(this.busySlot);

    this.rightText = staticText(renderer, {
      id: "prompt-right",
      content: "",
      fg: theme.muted,
      wrapMode: "none",
    });
    this.rightText.flexShrink = 0;
    footer.add(this.rightText);

    // The rule row carries its own left border so the `╹` corner survives the
    // full-width `▀` line drawn next to it. It sits outside the focused
    // subtree, so its tint is mirrored from the editor instead of inherited.
    const bottomRow = surface(renderer, {
      id: "prompt-bottom-row",
      width: "100%",
      flexShrink: 0,
      rule: { sides: ["left"], color: theme.border, vertical: "╹" },
    });
    bottomRow.height = 1;
    const bottomRule = new BoxRenderable(renderer, {
      id: "prompt-bottom-rule",
      width: "100%",
      height: 1,
      border: ["bottom"],
      borderColor: theme.element,
      customBorderChars: { ...OPENCODE_EMPTY_BORDER, horizontal: "▀" },
    });
    bottomRow.add(bottomRule);
    this.body.add(bottomRow);

    this.editor.on(RenderableEvents.FOCUSED, () => {
      bottomRow.borderColor = theme.accent;
    });
    this.editor.on(RenderableEvents.BLURRED, () => {
      bottomRow.borderColor = theme.border;
    });

    this.renderRight();
    this.refreshHeight();
  }

  focus(): void {
    this.editor.focus();
  }

  blur(): void {
    this.editor.blur();
  }

  isFocused(): boolean {
    return this.editor.focused;
  }

  isEmpty(): boolean {
    return this.editor.plainText.trim().length === 0;
  }

  peek(): string {
    return this.editor.plainText;
  }

  commit(): string | null {
    const text = this.editor.plainText.trim();
    this.clear();
    return text.length === 0 ? null : text;
  }

  clear(): void {
    this.editor.setText("");
    this.refreshHeight();
  }

  setMaxHeight(rows: number): void {
    this.maxHeight = Math.max(1, Math.floor(rows));
    this.editor.maxHeight = this.maxHeight;
    this.refreshHeight();
  }

  setStatus(status: PromptStatus): void {
    const wasBusy = this.status.busy;
    this.status = { ...status };
    this.busySlot.visible = status.busy;
    this.idleSlot.visible = !status.busy;
    if (status.busy) {
      if (!wasBusy) this.startSpinner();
    } else {
      this.stopSpinner();
    }
    this.renderRight();
  }

  setHint(text: string): void {
    this.hintText.content = text;
  }

  setPlaceholder(text: string | undefined): void {
    this.editor.placeholder = text ?? null;
  }

  refreshHeight(): void {
    const rows = bufferRows(this.editor.plainText, this.maxHeight);
    this.editor.height = rows;
    this.panel.height = rows + PANEL_PADDING_TOP + FOOTER_ROWS;
  }

  destroy(): void {
    this.stopSpinner();
    if (this.renderer.isDestroyed) return;
    if (!this.editor.isDestroyed) this.editor.destroy();
  }

  private renderRight(): void {
    const armed = this.status.interruptArmed;
    const context = formatContextCompact(this.status.contextUsed, this.status.contextTotal);
    const readout = context.length > 0 ? context : this.status.busy ? UNKNOWN_CONTEXT : "";
    const chunks = [
      fg(armed ? this.theme.accent : this.theme.text)("esc"),
      fg(armed ? this.theme.accent : this.theme.muted)(
        armed ? " again to interrupt" : " interrupt",
      ),
    ];
    if (readout.length > 0) chunks.push(fg(this.theme.muted)(` · ${readout}`));
    this.rightText.content = new StyledText(chunks);
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== null) return;
    this.spinnerTicks = 0;
    this.spinnerText.content = activityFrame(0);
    this.spinnerTimer = setInterval(() => {
      this.spinnerTicks += 1;
      this.spinnerText.content = activityFrame(this.spinnerTicks);
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === null) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }
}
