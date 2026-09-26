export type ThemeMode = "dark" | "light";

export interface UiTheme {
  mode: ThemeMode;
  background: string;
  panel: string;
  /** Element surfaces: the prompt box and other raised backgrounds. */
  element: string;
  text: string;
  muted: string;
  border: string;
  borderActive: string;
  primary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

// OpenCode's `carbonfox` theme (packages/tui/src/theme/assets/carbonfox.json),
// mapped onto LazyLlama's token set: near-black background ramp, cyan primary,
// pink accent, and a green/amber status pair. The theme has no alpha channels
// for muted/border, so those stay opaque here.
export const DARK_THEME: UiTheme = {
  mode: "dark",
  background: "#161616",
  panel: "#1a1a1a",
  element: "#1e1e1e",
  text: "#f2f4f8",
  muted: "#7d848f",
  border: "#303030",
  borderActive: "#33b1ff",
  primary: "#33b1ff",
  accent: "#ff7eb6",
  success: "#25be6a",
  warning: "#f1c21b",
  error: "#ee5396",
  info: "#78a9ff",
};

export const LIGHT_THEME: UiTheme = {
  mode: "light",
  background: "#ffffff",
  panel: "#f4f4f4",
  element: "#f4f4f4",
  text: "#161616",
  muted: "#6f6f6f",
  border: "#dcdcdc",
  borderActive: "#0043ce",
  primary: "#0043ce",
  accent: "#9f1853",
  success: "#198038",
  warning: "#007d79",
  error: "#9f1853",
  info: "#0043ce",
};

export function themeForMode(mode: ThemeMode | null | undefined): UiTheme {
  return mode === "light" ? LIGHT_THEME : DARK_THEME;
}
