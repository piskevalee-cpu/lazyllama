// Persisted UI flags (sidebar visibility, scrollbar, thinking display).
// Kept out of model presets: these are user preferences, not launch config.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config.js";
import { DEFAULT_SIDEBAR_STATE, type SidebarState } from "./layout.js";

export interface UiFlags {
  sidebar: SidebarState;
  scrollbar: boolean;
  /** Show model thinking/reasoning blocks in the transcript. */
  thinking: boolean;
}

export const DEFAULT_FLAGS: UiFlags = {
  sidebar: DEFAULT_SIDEBAR_STATE,
  scrollbar: true,
  thinking: true,
};

export function flagsPath(): string {
  return join(configDir(), "ui-flags.json");
}

function coerce(raw: unknown): UiFlags {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_FLAGS };
  const rec = raw as Record<string, unknown>;
  const sidebarRaw = rec["sidebar"];
  const sidebar: SidebarState =
    typeof sidebarRaw === "object" && sidebarRaw !== null && !Array.isArray(sidebarRaw)
      ? {
          pref: (sidebarRaw as Record<string, unknown>)["pref"] === "hide" ? "hide" : "auto",
          forced: (sidebarRaw as Record<string, unknown>)["forced"] === true,
        }
      : DEFAULT_SIDEBAR_STATE;
  return {
    sidebar,
    scrollbar: typeof rec["scrollbar"] === "boolean" ? (rec["scrollbar"] as boolean) : DEFAULT_FLAGS.scrollbar,
    thinking: typeof rec["thinking"] === "boolean" ? (rec["thinking"] as boolean) : DEFAULT_FLAGS.thinking,
  };
}

export function loadFlags(): UiFlags {
  const p = flagsPath();
  if (!existsSync(p)) return { ...DEFAULT_FLAGS };
  try {
    return coerce(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function saveFlags(flags: UiFlags): void {
  const p = flagsPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(flags, null, 2) + "\n", "utf8");
  } catch {
    // Preferences are best-effort; never break the TUI over a read-only home.
  }
}
