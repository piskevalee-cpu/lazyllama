// The manual screen: every llama-server parameter LazyLlama can affect, with
// llama.cpp's own default and what moving it actually changes. Opened with `?`
// or F1 from any screen, left with Esc.
//
// The copy lives in `src/manual.ts`; this file only renders it, so the manual
// and the config editor cannot disagree about a parameter. The tree is built
// once and only the per-parameter values are refreshed on open, so opening it
// costs a few text assignments rather than a hundred renderables.

import {
  BoxRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type TextRenderable,
} from "@opentui/core";
import {
  CONFIG_FIELDS,
  configValue,
  effectiveCommand,
  type LaunchConfig,
} from "../config.js";
import { scrollDelta, type ScrollCommand } from "./layout.js";
import { MANUAL_ENTRY_COUNT, MANUAL_GROUPS, MANUAL_INTRO, type ManualEntry } from "../manual.js";
import { staticText, surface } from "./components.js";
import { DARK_THEME, type UiTheme } from "./theme.js";

/** The manual adds the two absolute jumps to the transcript's scroll commands. */
export type ManualScrollCommand = ScrollCommand | "top" | "bottom";

// Every parameter that is not in its default state, in editor order. Derived
// from CONFIG_FIELDS, so it can never disagree with the config editor.
export function inForceSummary(cfg: LaunchConfig): string {
  const set = CONFIG_FIELDS.filter((def) => {
    if (!def.optional) return false;
    return (cfg as unknown as Record<string, unknown>)[def.key] !== null;
  }).map((def) => `${def.label.split(" (")[0] ?? def.label} ${configValue(def.key, (cfg as unknown as Record<string, never>)[def.key] as never)}`);
  if (set.length === 0) return "In force: only the model and the context — everything else is llama.cpp's own default.";
  return `In force: ${set.join(" · ")}`;
}

export class ManualView {
  readonly body: BoxRenderable;
  private readonly command: TextRenderable;
  private readonly inForce: TextRenderable;
  private readonly scroller: ScrollBoxRenderable;
  /** Entry headline per flag, refreshed with the current value on every open. */
  private readonly heads = new Map<string, TextRenderable>();

  constructor(
    private readonly renderer: CliRenderer,
    private readonly theme: UiTheme = DARK_THEME,
  ) {
    this.body = new BoxRenderable(renderer, {
      id: "manual",
      flexDirection: "column",
      flexGrow: 1,
      minHeight: 0,
      visible: false,
      paddingLeft: 2,
      paddingRight: 2,
    });

    // The header gets its own row with a blank line under it, so the title and
    // the command read as a header instead of running into the first entry.
    const header = surface(renderer, { id: "manual-header", flexShrink: 0, paddingBottom: 1 });
    header.add(
      staticText(renderer, { id: "manual-title", content: "Manual", fg: theme.text, bold: true }),
    );
    this.command = staticText(renderer, { id: "manual-command", fg: theme.muted, wrapMode: "word" });
    header.add(this.command);
    // What the current config actually changed, so the answer to "what did I
    // set?" is on the first screen instead of at the bottom of the document.
    this.inForce = staticText(renderer, { id: "manual-in-force", fg: theme.text, wrapMode: "word" });
    header.add(this.inForce);

    // Scrollbar options go through the constructor on purpose: that path leaves
    // the bar's manual-visibility flag unset, so it auto-hides when the whole
    // manual already fits. Group spacing goes on contentOptions, never as a
    // flexDirection on the root, which would stack the bar under the content.
    this.scroller = new ScrollBoxRenderable(renderer, {
      id: "manual-scroll",
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
    this.scroller.focusable = true;

    this.body.add(header);
    this.body.add(this.scroller);
    this.scroller.add(this.introBlock());
    for (const group of MANUAL_GROUPS) this.scroller.add(this.groupBlock(group));
  }

  setConfig(cfg: LaunchConfig): void {
    this.command.content = effectiveCommand(cfg);
    this.inForce.content = inForceSummary(cfg);
    for (const group of MANUAL_GROUPS) {
      for (const entry of group.entries) {
        if (entry.fieldKey === undefined) continue;
        const value = configValue(
          entry.fieldKey,
          (cfg as unknown as Record<string, unknown>)[entry.fieldKey] as never,
        );
        const head = this.heads.get(entry.flag);
        if (head) head.content = `${entry.flag}   →  ${value}`;
      }
    }
  }

  setVisible(visible: boolean): void {
    this.body.visible = visible;
    if (visible) {
      this.scroller.focus();
      this.scroller.scrollTo(0);
    } else {
      this.scroller.blur();
    }
  }

  isVisible(): boolean {
    return this.body.visible;
  }

  // Same page/half-page/line arithmetic as the transcript, so one mental model
  // covers both scrollables. The controller drives this: it owns the keys.
  scroll(command: ManualScrollCommand): void {
    const viewport = this.scroller.viewport.height ?? 1;
    switch (command) {
      case "top":
        this.scroller.scrollTo(0);
        return;
      case "bottom":
        this.scroller.scrollTo(this.scroller.scrollHeight);
        return;
      default:
        this.scroller.scrollBy(scrollDelta(viewport, command));
    }
  }

  private introBlock(): BoxRenderable {
    const box = surface(this.renderer, {
      id: "manual-intro",
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
        id: "manual-intro-text",
        content: MANUAL_INTRO,
        wrapMode: "word",
      }),
    );
    box.add(
      staticText(this.renderer, {
        id: "manual-count",
        content: `${MANUAL_ENTRY_COUNT} parameters · every default is llama.cpp's own`,
        fg: this.theme.muted,
      }),
    );
    return box;
  }

  private groupBlock(group: (typeof MANUAL_GROUPS)[number]): BoxRenderable {
    const box = surface(this.renderer, {
      id: `manual-group-${group.id}`,
      backgroundColor: this.theme.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      flexShrink: 0,
      width: "100%",
      rule: { sides: ["left"], color: this.theme.borderActive },
    });
    box.add(
      staticText(this.renderer, {
        id: `manual-group-${group.id}-title`,
        content: group.title,
        fg: this.theme.accent,
        bold: true,
      }),
    );
    box.add(
      staticText(this.renderer, {
        id: `manual-group-${group.id}-blurb`,
        content: group.blurb,
        fg: this.theme.muted,
        wrapMode: "word",
      }),
    );
    for (const entry of group.entries) {
      for (const row of this.entryRows(entry)) box.add(row);
    }
    return box;
  }

  private entryRows(entry: ManualEntry): TextRenderable[] {
    const head = staticText(this.renderer, {
      id: `manual-flag-${entry.flag}`,
      content: entry.flag,
      wrapMode: "word",
    });
    this.heads.set(entry.flag, head);
    return [
      head,
      staticText(this.renderer, {
        id: `manual-default-${entry.flag}`,
        content: `llama.cpp default: ${entry.llamaDefault}`,
        fg: this.theme.muted,
        wrapMode: "word",
      }),
      staticText(this.renderer, {
        id: `manual-effect-${entry.flag}`,
        content: entry.effect,
        wrapMode: "word",
      }),
    ];
  }
}
