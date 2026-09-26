import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIDEBAR_STATE,
  MIN_PROMPT_HEIGHT,
  SIDEBAR_WIDTH,
  WIDE_BREAKPOINT,
  contentWidth,
  isWide,
  promptMaxHeight,
  scrollDelta,
  sidebarMode,
  sidebarVisible,
  toggleSidebar,
  transcriptViewportPadding,
  type SidebarState,
} from "../src/ui/layout.ts";

describe("chat layout breakpoints", () => {
  test("the side panel is a column above 120 columns and hidden below", () => {
    expect(isWide(WIDE_BREAKPOINT)).toBe(false);
    expect(isWide(WIDE_BREAKPOINT + 1)).toBe(true);
    expect(sidebarMode(200, DEFAULT_SIDEBAR_STATE)).toBe("column");
    expect(sidebarMode(100, DEFAULT_SIDEBAR_STATE)).toBe("hidden");
  });

  test("a forced panel becomes an overlay on narrow terminals", () => {
    const forced: SidebarState = { pref: "auto", forced: true };
    expect(sidebarMode(80, forced)).toBe("overlay");
    expect(sidebarMode(140, forced)).toBe("column");
    expect(sidebarVisible(80, forced)).toBe(true);
  });

  test("toggling hides a visible panel and force-shows a hidden one", () => {
    const hidden = toggleSidebar(DEFAULT_SIDEBAR_STATE, 100);
    expect(hidden).toEqual({ pref: "auto", forced: true });
    expect(sidebarMode(100, hidden)).toBe("overlay");
    const shown = toggleSidebar(DEFAULT_SIDEBAR_STATE, 200);
    expect(shown).toEqual({ pref: "hide", forced: false });
    expect(sidebarMode(200, shown)).toBe("hidden");
  });

  test("content width subtracts the panel and the column padding", () => {
    expect(contentWidth(200, DEFAULT_SIDEBAR_STATE)).toBe(200 - SIDEBAR_WIDTH - 4);
    expect(contentWidth(200, { pref: "hide", forced: false })).toBe(196);
    expect(contentWidth(10, { pref: "hide", forced: false })).toBe(6);
  });

  test("prompt height is a third of the terminal with a floor", () => {
    expect(promptMaxHeight(40)).toBe(13);
    expect(promptMaxHeight(24)).toBe(8);
    expect(promptMaxHeight(6)).toBe(MIN_PROMPT_HEIGHT);
  });

  test("scrollbar reserve is one column only while visible", () => {
    expect(transcriptViewportPadding(true)).toBe(1);
    expect(transcriptViewportPadding(false)).toBe(0);
  });
});

describe("scroll deltas", () => {
  test("a page is half the viewport and a half page a quarter", () => {
    expect(scrollDelta(20, "page-up")).toBe(-10);
    expect(scrollDelta(20, "page-down")).toBe(10);
    expect(scrollDelta(20, "half-page-up")).toBe(-5);
    expect(scrollDelta(20, "half-page-down")).toBe(5);
    expect(scrollDelta(20, "line-up")).toBe(-1);
    expect(scrollDelta(20, "line-down")).toBe(1);
  });

  test("tiny viewports still move at least one row", () => {
    expect(scrollDelta(1, "page-down")).toBe(1);
    expect(scrollDelta(0, "half-page-down")).toBe(1);
    expect(scrollDelta(3, "half-page-up")).toBe(-1);
  });
});
