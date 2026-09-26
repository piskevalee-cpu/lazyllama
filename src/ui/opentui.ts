import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { themeForMode, type ThemeMode } from "./theme.js";

export const TERMINAL_TITLE = "LazyLlama";

// Mouse reporting is on by default (OpenCode parity: wheel scrolling,
// click-to-focus, hover and copy-on-select). `--no-mouse` or
// LAZYLLAMA_NO_MOUSE=1 turns it off for people who prefer the terminal's own
// text selection.
export function mouseEnabled(flag?: boolean): boolean {
  if (flag === false) return false;
  return process.env["LAZYLLAMA_NO_MOUSE"] !== "1";
}

// Renderer defaults replicate OpenCode's TUI host configuration that applies
// to an imperative Core app: explicit output mode, 60fps rendering, no stats,
// application-owned Ctrl+C/signal handling, Kitty keyboard support, no
// implicit focus changes, and no error console overlay. ctrl+y copies a
// selection, matching OpenCode's console keybinding.
export function rendererConfig(mouse: boolean): Parameters<typeof createCliRenderer>[0] {
  return {
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    exitSignals: [],
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: mouse,
    consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] },
  } as Parameters<typeof createCliRenderer>[0];
}

export const RENDERER_CONFIG = rendererConfig(mouseEnabled());

type DestroyableRenderer = Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">;

export async function createLazyRenderer(
  options: { mouse?: boolean } = {},
): Promise<{ renderer: CliRenderer; themeMode: ThemeMode }> {
  const renderer = await createCliRenderer(rendererConfig(mouseEnabled(options.mouse)));
  // Match OpenCode's startup behavior: prefer the terminal-reported theme mode,
  // then fall back to dark instead of blocking startup indefinitely.
  const themeMode = (await renderer.waitForThemeMode(1000)) ?? "dark";
  renderer.setTerminalTitle(TERMINAL_TITLE);
  renderer.setBackgroundColor(themeForMode(themeMode).background);
  return { renderer, themeMode };
}

// Mirror OpenCode's renderer teardown: always restore the terminal title, then
// destroy exactly once.
export function destroyRenderer(renderer: DestroyableRenderer): void {
  renderer.setTerminalTitle("");
  if (renderer.isDestroyed) return;
  renderer.destroy();
}
