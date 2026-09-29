// The keybinds screen: every command the app owns, with the key it is bound to
// right now, and the means to change it.
//
// The list comes from the registry in `src/ui/keybinds.ts`, so a command that
// appears here is a command that is really handled, and one that is handled is
// really listed. Values are read from the same overrides the keymap uses, so
// what the screen shows is what the keys do.
//
// Rebinding is a two-step: Enter starts recording, the next key press becomes
// the new binding. Recording cannot be cancelled with a key, because a key
// press is exactly what it is waiting for — Esc, being a key, records Esc.

import {
  BoxRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type TextRenderable,
} from "@opentui/core";
import {
  KEYBIND_DEFS,
  conflictsFor,
  defaultKeys,
  keyToSpec,
  prettyKeys,
  prettySpec,
  type KeybindDef,
  type KeybindOverrides,
  type KeybindScreen,
} from "./keybinds.js";
import { staticText, surface } from "./components.js";
import { scrollDelta, type ScrollCommand } from "./layout.js";
import { DARK_THEME, type UiTheme } from "./theme.js";

const SCREEN_TITLES: Record<KeybindScreen, string> = {
  global: "Everywhere",
  chat: "In chat",
  hub: "Model picker and config editor",
  overlay: "The launch config overlay",
  help: "The manual and this screen",
};

const SCREEN_ORDER: KeybindScreen[] = ["global", "chat", "hub", "overlay", "help"];

// Width of the label column, so every key starts in the same place.
const LABEL_WIDTH = 32;

export interface KeybindsViewEvents {
  /** Persist a new set of overrides. */
  onChange(overrides: KeybindOverrides): void;
}

export class KeybindsView {
  readonly body: BoxRenderable;
  private readonly status: TextRenderable;
  private readonly scroller: ScrollBoxRenderable;
  private readonly rows = new Map<string, TextRenderable>();
  private readonly groups: BoxRenderable[] = [];
  private overrides: KeybindOverrides = {};
  /** Index into the flat command list, which is what the arrows walk. */
  private cursor = 0;
  private recording = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly theme: UiTheme = DARK_THEME,
    private readonly events: KeybindsViewEvents,
  ) {
    this.body = new BoxRenderable(renderer, {
      id: "keybinds",
      flexDirection: "column",
      flexGrow: 1,
      minHeight: 0,
      visible: false,
      paddingLeft: 2,
      paddingRight: 2,
    });

    // The title is a header row of its own, with a blank line under it, so it
    // never presses against the list below.
    const header = surface(renderer, { id: "keybinds-header", flexShrink: 0, paddingBottom: 1 });
    header.add(
      staticText(renderer, { id: "keybinds-title", content: "Keybinds", fg: theme.text, bold: true }),
    );
    header.add(
      staticText(renderer, {
        id: "keybinds-subtitle",
        content: "Enter records the next key press · Del restores the default · Esc back",
        fg: theme.muted,
        wrapMode: "word",
      }),
    );
    this.status = staticText(renderer, { id: "keybinds-status", fg: theme.muted, wrapMode: "word" });

    // Scrollbar options go through the constructor on purpose: that path leaves
    // the bar's manual-visibility flag unset, so it auto-hides when the list
    // fits. Group spacing belongs on contentOptions, never as a flexDirection
    // on the root, which would stack the bar under the content.
    this.scroller = new ScrollBoxRenderable(renderer, {
      id: "keybinds-scroll",
      flexGrow: 1,
      minHeight: 0,
      width: "100%",
      contentOptions: { flexDirection: "column", gap: 1, paddingBottom: 1 },
      viewportOptions: { paddingRight: 1 },
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: theme.panel,
          foregroundColor: theme.borderActive,
        },
      },
    });
    this.scroller.focusable = false;
    this.build();

    this.body.add(header);
    this.body.add(this.scroller);
    this.body.add(this.status);
  }

  setOverrides(overrides: KeybindOverrides): void {
    this.overrides = overrides;
    this.refresh();
  }

  setVisible(visible: boolean): void {
    this.body.visible = visible;
    if (!visible) {
      this.recording = false;
      this.setStatus("");
      return;
    }
    this.refresh();
  }

  isVisible(): boolean {
    return this.body.visible;
  }

  isRecording(): boolean {
    return this.recording;
  }

  focusKeyId(): string {
    return KEYBIND_DEFS[this.cursor]?.id ?? "";
  }

  scroll(command: ScrollCommand | "top" | "bottom"): void {
    if (command === "top") this.scroller.scrollTo(0);
    else if (command === "bottom") this.scroller.scrollTo(this.scroller.scrollHeight);
    else this.scroller.scrollBy(scrollDelta(this.scroller.viewport.height ?? 1, command));
  }

  // Called by the controller for the navigation keys, so the screen owns its
  // own list rather than the controller reaching into it.
  //
  // Only the row losing the marker and the row gaining it are rewritten: moving
  // the cursor through fifty commands would otherwise dirty every row on every
  // press, which is both wasteful and enough churn to stall the renderer.
  moveCursor(delta: 1 | -1): void {
    const total = KEYBIND_DEFS.length;
    if (total === 0) return;
    const previous = this.cursor;
    this.cursor = (previous + delta + total) % total;
    this.renderRow(previous);
    this.renderRow(this.cursor);
    this.revealCursor();
  }

  /** Enter: start recording. The next key press becomes the binding. */
  beginRecord(): void {
    const def = KEYBIND_DEFS[this.cursor];
    if (def === undefined) return;
    if (def.fixed === true) {
      this.setStatus(`${def.label} is resolved inside the widget that draws it, so it is not rebindable.`);
      return;
    }
    this.recording = true;
    this.setStatus(`press a key for “${def.label}” · the next key press is recorded as-is`);
    this.renderRow(this.cursor);
  }

  /**
   * Record a key press. Returns true when the screen consumed the key, which it
   * always does while recording: a key press cannot fall through to a command.
   */
  record(key: Parameters<typeof keyToSpec>[0]): boolean {
    if (!this.recording) return false;
    const def = KEYBIND_DEFS[this.cursor];
    this.recording = false;
    if (def === undefined) return true;
    const spec = keyToSpec(key);
    const clash = conflictsFor(this.overrides, def.id, spec);
    this.overrides = { ...this.overrides, [def.id]: [spec] };
    this.events.onChange(this.overrides);
    this.setStatus(
      clash.length > 0
        ? `“${def.label}” is now ${prettySpec(spec)} — that key is also used by ${clash.join(", ")}.`
        : `“${def.label}” is now ${prettySpec(spec)}.`,
    );
    this.renderRow(this.cursor);
    return true;
  }

  /** Del: drop the override, so the command goes back to its shipped default. */
  resetSelected(): void {
    const def = KEYBIND_DEFS[this.cursor];
    if (def === undefined) return;
    if (this.overrides[def.id] === undefined) {
      this.setStatus(`“${def.label}” already uses its default.`);
      return;
    }
    const next = { ...this.overrides };
    delete next[def.id];
    this.overrides = next;
    this.events.onChange(next);
    this.setStatus(`“${def.label}” is back to its default: ${prettyKeys(defaultKeys(def.id))}.`);
    this.renderRow(this.cursor);
  }

  private setStatus(text: string): void {
    this.status.content = text;
  }

  private keysFor(def: KeybindDef): string[] {
    return this.overrides[def.id] ?? def.keys;
  }

  // The list is built once; a refresh only rewrites the row text, so opening
  // the screen and moving the cursor cost no renderables.
  private build(): void {
    for (const group of SCREEN_ORDER) {
      const defs = KEYBIND_DEFS.filter((def) => def.screen === group);
      if (defs.length === 0) continue;
      const box = surface(this.renderer, {
        id: `keybinds-group-${group}`,
        backgroundColor: this.theme.panel,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
        width: "100%",
        rule: { sides: ["left"], color: this.theme.border },
      });
      box.add(
        staticText(this.renderer, {
          id: `keybinds-group-${group}-title`,
          content: SCREEN_TITLES[group],
          fg: this.theme.accent,
          bold: true,
        }),
      );
      for (const def of defs) {
        const row = staticText(this.renderer, {
          id: `keybinds-row-${def.id}`,
          content: "",
          wrapMode: "word",
        });
        this.rows.set(def.id, row);
        box.add(row);
      }
      this.groups.push(box);
      this.scroller.add(box);
    }
  }

  private refresh(): void {
    for (let index = 0; index < KEYBIND_DEFS.length; index += 1) this.renderRow(index);
    this.revealCursor();
  }

  private renderRow(index: number): void {
    const def = KEYBIND_DEFS[index];
    if (def === undefined) return;
    const row = this.rows.get(def.id);
    if (row === undefined) return;
    const marked = index === this.cursor;
    const keys = prettyKeys(this.keysFor(def));
    const changed = this.overrides[def.id] !== undefined;
    const suffix = def.fixed === true ? "  (fixed)" : changed ? "  (changed)" : "";
    const recording = marked && this.recording ? "  ⟵ press a key" : "";
    // The label column is fixed so the keys line up; a longer one is cut rather
    // than allowed to collide with the key it describes.
    const label = def.label.length > LABEL_WIDTH ? `${def.label.slice(0, LABEL_WIDTH - 1)}…` : def.label;
    row.content = `${marked ? "▸" : " "} ${label.padEnd(LABEL_WIDTH)}${keys}${suffix}${recording}`;
    row.fg = marked ? this.theme.accent : changed ? this.theme.text : this.theme.muted;
  }

  // Keep the focused command in view. The row, not its group: a group is
  // taller than the viewport, so scrolling to the group can leave the cursor
  // off screen.
  private revealCursor(): void {
    const focused = KEYBIND_DEFS[this.cursor];
    if (focused !== undefined) {
      this.scroller.scrollChildIntoView(`keybinds-row-${focused.id}`);
    }
  }
}
