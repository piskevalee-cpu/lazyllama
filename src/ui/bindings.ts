// Session command registry. Ids, default keys and precedence mirror OpenCode's
// session command list so footer hints can be generated from the registry
// instead of hand-written strings that drift from the actual handling.

import type { KeyEvent } from "@opentui/core";
import { keysFor, type KeybindOverrides } from "./keybinds.js";
import type { ScrollCommand } from "./layout.js";
import type { Binding } from "./keys.js";

export interface SessionCommandContext {
  /** A request is in flight, so Esc arms/aborts and the prompt shows a spinner. */
  busy: boolean;
  /** Esc already armed the interrupt inside its window. */
  interruptArmed: boolean;
  /** The prompt currently holds text. */
  promptDirty: boolean;
  /** A modal surface (config overlay) is open and owns Esc. */
  modalOpen: boolean;
  /** A text selection exists; Esc clears it instead of anything else. */
  selectionActive: boolean;
}

export interface SessionCommands {
  submit(): void;
  /** Leave the chat and go back to the model picker. */
  exit(): void;
  interrupt(): void;
  toggleSidebar(): void;
  toggleScrollbar(): void;
  toggleThinking(): void;
  toggleConfig(): void;
  toggleSidebarCursor(): void;
  moveSidebarCursor(delta: 1 | -1): void;
  activateSidebarCursor(): void;
  clearPrompt(): void;
  scroll(command: ScrollCommand): void;
  scrollTop(): void;
  scrollBottom(): void;
  quit(): void;
  closeModal(): void;
  clearSelection(): void;
}

// The chat's scroll commands are ids, not key lists: the keys live in the
// registry, so a rebind reaches the keymap and the manual's scroller at once.
const SCROLL_IDS: Record<ScrollCommand, string> = {
  "page-up": "session.scroll.page-up",
  "page-down": "session.scroll.page-down",
  "half-page-up": "session.scroll.half-page-up",
  "half-page-down": "session.scroll.half-page-down",
  "line-up": "session.scroll.line-up",
  "line-down": "session.scroll.line-down",
};

export function scrollBinding(
  command: ScrollCommand,
  label: string,
  run: () => void,
  keys: (id: string) => string[],
  scope: Binding["scope"] = "global",
): Binding {
  return {
    id: `session.scroll.${command}`,
    keys: keys(SCROLL_IDS[command]),
    description: label,
    scope,
    run: () => run(),
  };
}

// Registration order is the precedence order. Esc appears once, as a chain.
export function sessionBindings(
  ctx: SessionCommandContext,
  commands: SessionCommands,
  overrides: KeybindOverrides = {},
): Binding[] {
  // Every binding reads its keys from the registry, so a rebind reaches the
  // keymap without this file knowing anything about the user's choices.
  const keys = (id: string): string[] => keysFor(overrides, id);
  return [
    {
      id: "app.quit",
      keys: keys("app.quit"),
      description: "quit",
      when: () => !ctx.selectionActive,
      run: () => commands.quit(),
    },
    {
      id: "prompt.submit",
      keys: keys("prompt.submit"),
      description: "send",
      scope: "editor",
      when: () => !ctx.modalOpen,
      run: (key: KeyEvent) => {
        // Stop the textarea's own newline action from also firing.
        key.preventDefault();
        commands.submit();
      },
    },
    {
      // The one Escape chain, most specific first: modal, then selection,
      // then the two-step interrupt, then clearing a dirty prompt.
      id: "modal.close",
      keys: keys("modal.close"),
      description: "close",
      when: () => ctx.modalOpen,
      run: () => commands.closeModal(),
    },
    {
      id: "selection.clear",
      keys: keys("selection.clear"),
      description: "clear selection",
      when: () => !ctx.modalOpen && ctx.selectionActive,
      run: () => commands.clearSelection(),
    },
    {
      id: "session.interrupt",
      keys: keys("session.interrupt"),
      description: "interrupt",
      when: () => !ctx.modalOpen && !ctx.selectionActive && ctx.busy,
      run: () => commands.interrupt(),
    },
    {
      id: "prompt.clear",
      keys: keys("prompt.clear"),
      description: "clear prompt",
      when: () => !ctx.modalOpen && !ctx.selectionActive && !ctx.busy && ctx.promptDirty,
      run: () => commands.clearPrompt(),
    },
    {
      // Leaving the chat is not a quit: the server keeps running and the
      // conversation stays on the transcript when you come back.
      id: "session.exit",
      keys: keys("session.exit"),
      description: "back to the menu",
      run: () => commands.exit(),
    },
    scrollBinding("page-up", "PgUp scroll", () => commands.scroll("page-up"), keys),
    scrollBinding("page-down", "PgDn scroll", () => commands.scroll("page-down"), keys),
    scrollBinding("half-page-up", "half page up", () => commands.scroll("half-page-up"), keys),
    scrollBinding("half-page-down", "half page down", () => commands.scroll("half-page-down"), keys),
    scrollBinding("line-up", "line up", () => commands.scroll("line-up"), keys),
    scrollBinding("line-down", "line down", () => commands.scroll("line-down"), keys),
    {
      id: "session.scroll.top",
      keys: keys("session.scroll.top"),
      description: "scroll to top",
      scope: "unfocused",
      run: () => commands.scrollTop(),
    },
    {
      id: "session.scroll.bottom",
      keys: keys("session.scroll.bottom"),
      description: "scroll to bottom",
      scope: "unfocused",
      run: () => commands.scrollBottom(),
    },
    {
      id: "session.sidebar.toggle",
      keys: keys("session.sidebar.toggle"),
      description: "toggle panel",
      run: () => commands.toggleSidebar(),
    },
    {
      id: "session.sidebar.cursor",
      keys: keys("session.sidebar.cursor"),
      description: "panel sections",
      run: () => commands.toggleSidebarCursor(),
    },
    {
      id: "session.toggle.scrollbar",
      keys: keys("session.toggle.scrollbar"),
      description: "toggle scrollbar",
      run: () => commands.toggleScrollbar(),
    },
    {
      id: "session.toggle.thinking",
      keys: keys("session.toggle.thinking"),
      description: "toggle thinking",
      run: () => commands.toggleThinking(),
    },
    {
      id: "config.toggle",
      keys: keys("config.toggle"),
      description: "config",
      run: () => commands.toggleConfig(),
    },
    {
      id: "prompt.sidebar.prev",
      keys: keys("session.sidebar.prev"),
      description: "panel section up",
      run: () => commands.moveSidebarCursor(-1),
    },
    {
      id: "prompt.sidebar.next",
      keys: keys("session.sidebar.next"),
      description: "panel section down",
      run: () => commands.moveSidebarCursor(1),
    },
    {
      id: "prompt.sidebar.activate",
      keys: keys("session.sidebar.fold"),
      description: "fold section",
      run: () => commands.activateSidebarCursor(),
    },
  ];
}

// Footer hint text is derived from the registry so it can never claim a key
// the handler does not implement.
export function hintsFor(bindings: Binding[], limit = 4): string {
  const parts: string[] = [];
  for (const binding of bindings) {
    if (parts.length >= limit) break;
    if (binding.keys.length === 0) continue;
    parts.push(`${binding.keys[0]} ${binding.description}`);
  }
  return parts.join(" · ");
}
