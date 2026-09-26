import { describe, expect, test } from "bun:test";
import { canonicalKeyName, matchesKeySpec, parseKeySpec } from "../src/ui/keys.ts";
import {
  RENDERER_CONFIG,
  TERMINAL_TITLE,
  destroyRenderer,
  mouseEnabled,
  rendererConfig,
} from "../src/ui/opentui.ts";
import { activityFrame, ACTIVITY_FRAMES } from "../src/ui/spinner.ts";
import { DARK_THEME, LIGHT_THEME, themeForMode } from "../src/ui/theme.ts";

describe("OpenCode-derived renderer configuration", () => {
  test("renderer defaults match the shared host configuration", () => {
    expect(TERMINAL_TITLE).toBe("LazyLlama");
    expect(RENDERER_CONFIG).toEqual({
      externalOutputMode: "passthrough",
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      exitSignals: [],
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
      useMouse: true,
      consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] },
    });
  });

  test("mouse reporting is opt-out via flag or environment", () => {
    expect(mouseEnabled()).toBe(true);
    expect(mouseEnabled(true)).toBe(true);
    expect(mouseEnabled(false)).toBe(false);
    expect(rendererConfig(false).useMouse).toBe(false);
    const previous = process.env["LAZYLLAMA_NO_MOUSE"];
    process.env["LAZYLLAMA_NO_MOUSE"] = "1";
    expect(mouseEnabled()).toBe(false);
    expect(mouseEnabled(true)).toBe(false);
    if (previous === undefined) delete process.env["LAZYLLAMA_NO_MOUSE"];
    else process.env["LAZYLLAMA_NO_MOUSE"] = previous;
  });

  test("binding specs parse and match OpenTUI key events", () => {
    expect(parseKeySpec("ctrl+alt+b")).toEqual({ name: "b", ctrl: true, alt: true });
    expect(parseKeySpec("shift+return")).toEqual({ name: "return", shift: true });
    expect(parseKeySpec("esc")).toEqual({ name: "escape" });
    const key = { name: "b", ctrl: true, meta: false, shift: false, option: false, super: false };
    expect(matchesKeySpec(key, "ctrl+b")).toBe(true);
    expect(matchesKeySpec(key, "ctrl+alt+b")).toBe(false);
    expect(matchesKeySpec(key, "b")).toBe(false);
    expect(matchesKeySpec({ ...key, ctrl: false }, "b")).toBe(true);
  });

  test("renderer teardown restores the terminal title exactly once", () => {
    const calls: string[] = [];
    destroyRenderer({
      isDestroyed: false,
      setTerminalTitle(title: string) {
        calls.push(`title:${title}`);
      },
      destroy() {
        calls.push("destroy");
      },
    });
    expect(calls).toEqual(["title:", "destroy"]);
  });

  test("renderer teardown still restores the title when already destroyed", () => {
    const calls: string[] = [];
    destroyRenderer({
      isDestroyed: true,
      setTerminalTitle(title: string) {
        calls.push(`title:${title}`);
      },
      destroy() {
        calls.push("destroy");
      },
    });
    expect(calls).toEqual(["title:"]);
  });
});

function greyValue(hex: string): number {
  return Number.parseInt(hex.slice(1, 3), 16);
}

function isGrey(hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return r === g && g === b;
}

describe("OpenCode-derived theme configuration", () => {
  test("the palette is monochrome black, white and a grey ramp", () => {
    expect(DARK_THEME.background).toBe("#000000");
    expect(DARK_THEME.text).toBe("#ffffff");
    expect(DARK_THEME.accent).toBe("#ffffff");
    // Surfaces climb the grey ramp: panel < element < border < muted.
    const ramp = [DARK_THEME.panel, DARK_THEME.element, DARK_THEME.border, DARK_THEME.muted];
    for (let i = 1; i < ramp.length; i += 1) {
      expect(greyValue(ramp[i - 1]!)).toBeLessThan(greyValue(ramp[i]!));
    }
    expect(DARK_THEME.meter).toEqual(["#ffffff", "#b4b4b4", "#6e6e6e"]);
    for (const stop of [...DARK_THEME.meter, DARK_THEME.meterTrack, DARK_THEME.borderActive]) {
      expect(isGrey(stop)).toBe(true);
    }
    expect(LIGHT_THEME.background).toBe("#ffffff");
    expect(LIGHT_THEME.text).toBe("#0a0a0a");
    expect(isGrey(LIGHT_THEME.meter[0]!)).toBe(true);
  });

  test("missing theme mode falls back to dark", () => {
    expect(themeForMode("light")).toBe(LIGHT_THEME);
    expect(themeForMode("dark")).toBe(DARK_THEME);
    expect(themeForMode(null)).toBe(DARK_THEME);
    expect(themeForMode(undefined)).toBe(DARK_THEME);
  });
});

describe("OpenCode-derived input configuration", () => {
  test("key aliases normalize to canonical OpenTUI names", () => {
    expect(canonicalKeyName("enter")).toBe("return");
    expect(canonicalKeyName("esc")).toBe("escape");
    expect(canonicalKeyName("pgup")).toBe("pageup");
    expect(canonicalKeyName("pgdn")).toBe("pagedown");
    expect(canonicalKeyName("return")).toBe("return");
  });

  test("activity indicator uses the shared Braille frame sequence", () => {
    expect(ACTIVITY_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    expect(activityFrame(0)).toBe("⠋");
    expect(activityFrame(10)).toBe("⠋");
    expect(activityFrame(-1)).toBe("⠏");
  });
});
