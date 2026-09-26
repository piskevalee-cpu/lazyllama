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
  /** Fill-bar ramp: the gradient a filled meter fades through. */
  meter: [string, string, string];
  /** Track behind a meter fill. */
  meterTrack: string;
}

// Monochrome: black and white with a grey ramp. Surfaces climb the ramp
// (background -> panel -> element -> border) and the meters fade through
// `meter` so a filled bar reads as a gradient rather than a flat block.
export const DARK_THEME: UiTheme = {
  mode: "dark",
  background: "#000000",
  panel: "#0a0a0a",
  element: "#141414",
  text: "#ffffff",
  muted: "#8c8c8c",
  border: "#262626",
  borderActive: "#e6e6e6",
  primary: "#e6e6e6",
  accent: "#ffffff",
  success: "#a3a3a3",
  warning: "#cfcfcf",
  error: "#ffffff",
  info: "#8c8c8c",
  meter: ["#ffffff", "#b4b4b4", "#6e6e6e"],
  meterTrack: "#242424",
};

export const LIGHT_THEME: UiTheme = {
  mode: "light",
  background: "#ffffff",
  panel: "#fafafa",
  element: "#f0f0f0",
  text: "#0a0a0a",
  muted: "#6b6b6b",
  border: "#d6d6d6",
  borderActive: "#1a1a1a",
  primary: "#1a1a1a",
  accent: "#000000",
  success: "#3f3f3f",
  warning: "#5a5a5a",
  error: "#000000",
  info: "#6b6b6b",
  meter: ["#0a0a0a", "#4d4d4d", "#9a9a9a"],
  meterTrack: "#e4e4e4",
};

export function themeForMode(mode: ThemeMode | null | undefined): UiTheme {
  return mode === "light" ? LIGHT_THEME : DARK_THEME;
}
