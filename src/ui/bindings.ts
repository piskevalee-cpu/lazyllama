// Session command registry. Ids, default keys and precedence mirror OpenCode's
// session command list so footer hints can be generated from the registry
// instead of hand-written strings that drift from the actual handling.

import type { KeyEvent } from "@opentui/core";
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

const SCROLL_KEYS: Record<ScrollCommand, string[]> = {
  // OpenCode's "page" is half the viewport, "half page" a quarter of it.
  "page-up": ["pageup", "ctrl+alt+b"],
  "page-down": ["pagedown", "ctrl+alt+f"],
  "half-page-up": ["ctrl+alt+u"],
  "half-page-down": ["ctrl+alt+d"],
  "line-up": ["ctrl+alt+y"],
  "line-down": ["ctrl+alt+e"],
};

export function scrollBinding(
  command: ScrollCommand,
  label: string,
  run: () => void,
  scope: Binding["scope"] = "global",
): Binding {
  return {
    id: `session.scroll.${command}`,
    keys: SCROLL_KEYS[command],
    description: label,
    scope,
    run: () => run(),
  };
}

// Registration order is the precedence order. Esc appears once, as a chain.
export function sessionBindings(
  ctx: SessionCommandContext,
  commands: SessionCommands,
): Binding[] {
  return [
    {
      id: "app.quit",
      keys: ["ctrl+c"],
      description: "quit",
      when: () => !ctx.selectionActive,
      run: () => commands.quit(),
    },
    {
      id: "prompt.submit",
      keys: ["return", "kpenter", "linefeed"],
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
      keys: ["escape", "q"],
      description: "close",
      when: () => ctx.modalOpen,
      run: () => commands.closeModal(),
    },
    {
      id: "selection.clear",
      keys: ["escape"],
      description: "clear selection",
      when: () => !ctx.modalOpen && ctx.selectionActive,
      run: () => commands.clearSelection(),
    },
    {
      id: "session.interrupt",
      keys: ["escape"],
      description: "interrupt",
      when: () => !ctx.modalOpen && !ctx.selectionActive && ctx.busy,
      run: () => commands.interrupt(),
    },
    {
      id: "prompt.clear",
      keys: ["escape"],
      description: "clear prompt",
      when: () => !ctx.modalOpen && !ctx.selectionActive && !ctx.busy && ctx.promptDirty,
      run: () => commands.clearPrompt(),
    },
    scrollBinding("page-up", "PgUp scroll", () => commands.scroll("page-up")),
    scrollBinding("page-down", "PgDn scroll", () => commands.scroll("page-down")),
    scrollBinding("half-page-up", "half page up", () => commands.scroll("half-page-up")),
    scrollBinding("half-page-down", "half page down", () => commands.scroll("half-page-down")),
    scrollBinding("line-up", "line up", () => commands.scroll("line-up")),
    scrollBinding("line-down", "line down", () => commands.scroll("line-down")),
    {
      id: "session.scroll.top",
      keys: ["ctrl+g", "home"],
      description: "scroll to top",
      scope: "unfocused",
      run: () => commands.scrollTop(),
    },
    {
      id: "session.scroll.bottom",
      keys: ["ctrl+alt+g", "end"],
      description: "scroll to bottom",
      scope: "unfocused",
      run: () => commands.scrollBottom(),
    },
    {
      id: "session.sidebar.toggle",
      keys: ["ctrl+b"],
      description: "toggle panel",
      run: () => commands.toggleSidebar(),
    },
    {
      id: "session.sidebar.cursor",
      keys: ["alt+b"],
      description: "panel sections",
      run: () => commands.toggleSidebarCursor(),
    },
    {
      id: "session.toggle.scrollbar",
      keys: ["ctrl+r"],
      description: "toggle scrollbar",
      run: () => commands.toggleScrollbar(),
    },
    {
      id: "session.toggle.thinking",
      keys: ["ctrl+t"],
      description: "toggle thinking",
      run: () => commands.toggleThinking(),
    },
    {
      id: "config.toggle",
      keys: ["f2"],
      description: "config",
      run: () => commands.toggleConfig(),
    },
    {
      id: "prompt.sidebar.prev",
      keys: ["alt+up"],
      description: "panel section up",
      run: () => commands.moveSidebarCursor(-1),
    },
    {
      id: "prompt.sidebar.next",
      keys: ["alt+down"],
      description: "panel section down",
      run: () => commands.moveSidebarCursor(1),
    },
    {
      id: "prompt.sidebar.activate",
      keys: ["alt+return"],
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
