// Pure responsive layout math for the chat shell. No OpenTUI imports so the
// breakpoint, sidebar mode and prompt sizing rules stay unit-testable.
//
// Mirrors OpenCode's session layout: a fixed-width side column on wide
// terminals, an absolute overlay with a scrim on narrow ones, and a
// bottom-anchored prompt whose height is a fraction of the terminal.

export const SIDEBAR_WIDTH = 42;
export const WIDE_BREAKPOINT = 120;
export const MIN_PROMPT_HEIGHT = 6;
export const SCROLLBAR_RESERVE = 1;

export type SidebarPreference = "auto" | "hide";

export interface SidebarState {
  pref: SidebarPreference;
  /** Set by the explicit toggle so a narrow terminal can force the overlay on. */
  forced: boolean;
}

export type SidebarMode = "hidden" | "column" | "overlay";

export const DEFAULT_SIDEBAR_STATE: SidebarState = { pref: "auto", forced: false };

export function isWide(width: number): boolean {
  return width > WIDE_BREAKPOINT;
}

export function sidebarVisible(width: number, state: SidebarState): boolean {
  return state.forced || (state.pref === "auto" && isWide(width));
}

export function sidebarMode(width: number, state: SidebarState): SidebarMode {
  if (!sidebarVisible(width, state)) return "hidden";
  return isWide(width) ? "column" : "overlay";
}

// Toggle mirrors OpenCode: a visible panel becomes "hide", a hidden panel
// becomes "auto" + forced so it also shows on narrow terminals.
export function toggleSidebar(state: SidebarState, width: number): SidebarState {
  return sidebarVisible(width, state)
    ? { pref: "hide", forced: false }
    : { pref: "auto", forced: true };
}

// Columns left for the transcript column, excluding its own side padding.
export function contentWidth(width: number, state: SidebarState, padding = 4): number {
  const mode = sidebarMode(width, state);
  return Math.max(1, width - (mode === "hidden" ? 0 : SIDEBAR_WIDTH) - padding);
}

export function promptMaxHeight(terminalHeight: number): number {
  return Math.max(MIN_PROMPT_HEIGHT, Math.floor(terminalHeight / 3));
}

export type ScrollCommand =
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "line-up"
  | "line-down";

// OpenCode's naming is counter-intuitive on purpose: a "page" is half the
// viewport and a "half page" is a quarter of it.
export function scrollDelta(viewportHeight: number, command: ScrollCommand): number {
  const height = Math.max(1, viewportHeight);
  switch (command) {
    case "page-up":
      return -Math.max(1, Math.floor(height / 2));
    case "page-down":
      return Math.max(1, Math.floor(height / 2));
    case "half-page-up":
      return -Math.max(1, Math.floor(height / 4));
    case "half-page-down":
      return Math.max(1, Math.floor(height / 4));
    case "line-up":
      return -1;
    case "line-down":
      return 1;
  }
}

// Message list reserve for the transcript scrollbar column.
export function transcriptViewportPadding(scrollbarVisible: boolean): number {
  return scrollbarVisible ? SCROLLBAR_RESERVE : 0;
}
