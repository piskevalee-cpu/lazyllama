// Every keybinding the app owns, in one registry.
//
// The chat keymap is built from this registry (`bindings.ts`), the per-screen
// key handling in the controller looks commands up by id, the footer hints are
// generated from it so they cannot drift from the real handling, and
// `KeybindsView` renders it as the screen the user edits. A command is
// rebound in exactly one place and every consumer follows.
//
// Overrides live in `configDir()/keybinds.json` and are keyed by command id, so
// a file written by an older build keeps working and unknown ids are ignored
// rather than fatal. Preferences are best-effort: a broken file is ignored and
// a read-only home must never break the TUI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { configDir } from "../config.js";
import { canonicalKeyName, matchesKeySpec, parseKeySpec } from "./keys.js";

/** Where a command is handled. The keybinds screen groups by this. */
export type KeybindScreen = "global" | "chat" | "hub" | "overlay" | "help";

export interface KeybindDef {
  id: string;
  /** What the command does, as shown in the editor and in footer hints. */
  label: string;
  keys: string[];
  screen: KeybindScreen;
  /**
   * Keys the renderables own: activating a selected row, the textarea's own
   * newline handling. They are listed so the reference is complete, but they
   * cannot be rebound, because OpenTUI resolves them inside the renderable.
   */
  fixed?: boolean;
}

export const KEYBIND_DEFS: KeybindDef[] = [
  // Global: reachable from every screen.
  { id: "app.quit", label: "quit", keys: ["ctrl+c"], screen: "global" },
  { id: "help.manual", label: "manual", keys: ["?", "f1"], screen: "global" },
  { id: "help.keybinds", label: "keybinds", keys: ["ctrl+k"], screen: "global" },
  { id: "modal.close", label: "close", keys: ["escape", "q"], screen: "global" },

  // Chat.
  { id: "prompt.submit", label: "send", keys: ["return", "kpenter", "linefeed"], screen: "chat" },
  { id: "session.interrupt", label: "interrupt", keys: ["escape"], screen: "chat" },
  { id: "prompt.clear", label: "clear prompt", keys: ["escape"], screen: "chat" },
  { id: "selection.clear", label: "clear selection", keys: ["escape"], screen: "chat" },
  { id: "selection.copy", label: "copy", keys: ["ctrl+c"], screen: "chat" },
  { id: "session.scroll.page-up", label: "scroll half a screen up", keys: ["pageup", "ctrl+alt+b"], screen: "chat" },
  { id: "session.scroll.page-down", label: "scroll half a screen down", keys: ["pagedown", "ctrl+alt+f"], screen: "chat" },
  { id: "session.scroll.half-page-up", label: "scroll a quarter up", keys: ["ctrl+alt+u"], screen: "chat" },
  { id: "session.scroll.half-page-down", label: "scroll a quarter down", keys: ["ctrl+alt+d"], screen: "chat" },
  { id: "session.scroll.line-up", label: "scroll one line up", keys: ["ctrl+alt+y"], screen: "chat" },
  { id: "session.scroll.line-down", label: "scroll one line down", keys: ["ctrl+alt+e"], screen: "chat" },
  { id: "session.scroll.top", label: "jump to the top", keys: ["ctrl+g", "home"], screen: "chat" },
  { id: "session.scroll.bottom", label: "jump to the bottom", keys: ["ctrl+alt+g", "end"], screen: "chat" },
  { id: "session.sidebar.toggle", label: "toggle the side panel", keys: ["ctrl+b"], screen: "chat" },
  { id: "session.sidebar.cursor", label: "walk the panel sections", keys: ["alt+b"], screen: "chat" },
  { id: "session.sidebar.fold", label: "fold a panel section", keys: ["alt+return"], screen: "chat" },
  { id: "session.sidebar.prev", label: "previous panel section", keys: ["alt+up"], screen: "chat" },
  { id: "session.sidebar.next", label: "next panel section", keys: ["alt+down"], screen: "chat" },
  { id: "session.toggle.scrollbar", label: "toggle the transcript scrollbar", keys: ["ctrl+r"], screen: "chat" },
  { id: "session.toggle.thinking", label: "show or hide thinking", keys: ["ctrl+t"], screen: "chat" },
  { id: "config.toggle", label: "the launch config overlay", keys: ["f2"], screen: "chat" },
  { id: "session.exit", label: "back to the menu", keys: ["ctrl+x"], screen: "chat" },
  { id: "prompt.newline", label: "newline", keys: ["shift+return", "ctrl+return", "return", "ctrl+j"], screen: "chat", fixed: true },

  // The in-chat config overlay.
  { id: "overlay.adjust-left", label: "smaller context", keys: ["left", "-", "_"], screen: "overlay" },
  { id: "overlay.adjust-right", label: "larger context", keys: ["right", "+", "="], screen: "overlay" },
  { id: "overlay.gpu", label: "gpu layers", keys: ["g"], screen: "overlay" },
  { id: "overlay.jinja", label: "jinja", keys: ["j"], screen: "overlay" },
  { id: "overlay.props", label: "props", keys: ["p"], screen: "overlay" },
  { id: "overlay.metrics", label: "metrics", keys: ["m"], screen: "overlay" },
  { id: "overlay.save", label: "save the preset", keys: ["s"], screen: "overlay" },

  // The model picker and the config editor.
  { id: "hub.models.move-up", label: "select the row above", keys: ["up"], screen: "hub" },
  { id: "hub.models.move-down", label: "select the row below", keys: ["down"], screen: "hub" },
  { id: "hub.models.move-left", label: "select the row above", keys: ["left"], screen: "hub" },
  { id: "hub.models.move-right", label: "select the row below", keys: ["right"], screen: "hub" },
  { id: "hub.models.open", label: "open the model", keys: ["return", "kpenter"], screen: "hub", fixed: true },
  { id: "hub.models.refresh", label: "rescan the models", keys: ["r"], screen: "hub" },
  { id: "hub.edit.move-up", label: "move up a row", keys: ["up"], screen: "hub" },
  { id: "hub.edit.move-down", label: "move down a row", keys: ["down"], screen: "hub" },
  { id: "hub.edit.adjust-left", label: "adjust the value", keys: ["left", "-", "_"], screen: "hub" },
  { id: "hub.edit.adjust-right", label: "adjust the value", keys: ["right", "+", "="], screen: "hub" },
  { id: "hub.edit.prev-group", label: "previous group", keys: ["shift+tab"], screen: "hub" },
  { id: "hub.edit.next-group", label: "next group", keys: ["tab"], screen: "hub" },
  { id: "hub.edit.save", label: "save the preset", keys: ["s"], screen: "hub" },
  { id: "hub.edit.back", label: "back to the models", keys: ["escape"], screen: "hub" },
  { id: "hub.edit.cancel", label: "cancel the inline edit", keys: ["escape"], screen: "hub" },
  { id: "hub.edit.open", label: "edit the value inline", keys: ["return", "kpenter"], screen: "hub", fixed: true },

  // The help screens.
  { id: "manual.close", label: "back", keys: ["escape"], screen: "help" },
  // The page and jump commands are the chat's, so one rebinding scrolls both
  // the transcript and the help screens.
  { id: "help.scroll.line-up", label: "scroll one line up", keys: ["up"], screen: "help" },
  { id: "help.scroll.line-down", label: "scroll one line down", keys: ["down"], screen: "help" },
  { id: "keybinds.close", label: "back", keys: ["escape"], screen: "help" },
  { id: "keybinds.rebind", label: "record the next key press", keys: ["return"], screen: "help" },
  { id: "keybinds.reset", label: "restore the default", keys: ["delete"], screen: "help" },
];

const BY_ID = new Map(KEYBIND_DEFS.map((def) => [def.id, def]));

export function keybindDef(id: string): KeybindDef | undefined {
  return BY_ID.get(id);
}

/** Default keys for a command, ignoring overrides. */
export function defaultKeys(id: string): string[] {
  return BY_ID.get(id)?.keys ?? [];
}

export function isFixed(id: string): boolean {
  return BY_ID.get(id)?.fixed === true;
}

export type KeybindOverrides = Record<string, string[]>;

/**
 * A KeyEvent as a spec string, so a key press the user just made can be stored
 * and later matched. Round-trips with `matchesKeySpec`.
 */
export function keyToSpec(key: KeyEvent): string {
  const name = canonicalKeyName(key.name);
  const parts: string[] = [];
  if (key.ctrl === true) parts.push("ctrl");
  if (key.option === true) parts.push("alt");
  // Shift on a character that cannot be typed without it is implied, so `?` is
  // stored as "?" and not as "shift+?".
  const implied = name.length === 1 && !/[a-z0-9 ]/.test(name);
  if (key.shift === true && !implied) parts.push("shift");
  if (key.meta === true) parts.push("meta");
  if (key.super === true) parts.push("super");
  parts.push(name);
  return parts.join("+");
}

// Pretty form for a spec, used in the keybinds screen: modifiers capitalised,
// names spelled the way a person would read them aloud.
const PRETTY: Record<string, string> = {
  return: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Del",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  space: "Space",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  tab: "Tab",
  kpenter: "Numpad Enter",
};

export function prettySpec(spec: string): string {
  const parts = spec.split("+");
  const name = parts[parts.length - 1] ?? spec;
  // A function key is spelled F1, F2, ... rather than f1.
  const fnKey = /^f\d+$/.test(name) ? name.toUpperCase() : undefined;
  const prettyName = fnKey ?? PRETTY[name] ?? (name.length === 1 ? name.toUpperCase() : name);
  const modifiers = parts.slice(0, -1).map((mod) => {
    if (mod === "ctrl") return "Ctrl";
    if (mod === "alt") return "Alt";
    if (mod === "shift") return "Shift";
    if (mod === "meta") return "Meta";
    if (mod === "super") return "Super";
    return mod;
  });
  return [...modifiers, prettyName].join("+");
}

export function prettyKeys(keys: string[]): string {
  return keys.map(prettySpec).join(" / ");
}

/** The keys a command is actually bound to: its override, or its default. */
export function resolveKeys(overrides: KeybindOverrides, id: string): string[] {
  const override = overrides[id];
  if (override !== undefined && override.length > 0) return override;
  return defaultKeys(id);
}

export function keysFor(overrides: KeybindOverrides, id: string): string[] {
  return resolveKeys(overrides, id);
}

/** True when this key press is the given command's current binding. */
export function pressedCommand(overrides: KeybindOverrides, id: string, key: KeyEvent): boolean {
  return resolveKeys(overrides, id).some((spec) => matchesKeySpec(key, spec));
}

/** Commands that would also fire on this key, so a rebind can warn. */
export function conflictsFor(overrides: KeybindOverrides, id: string, spec: string): string[] {
  const out: string[] = [];
  for (const def of KEYBIND_DEFS) {
    if (def.id === id) continue;
    if (resolveKeys(overrides, def.id).includes(spec)) out.push(def.label);
  }
  return out;
}

/** Every spec in use, so a rebind can be validated against a key event. */
export function isKnownSpec(spec: string): boolean {
  const parsed = parseKeySpec(spec);
  return parsed.name.length > 0;
}

// ---- persistence --------------------------------------------------------

export function keybindsPath(): string {
  return join(configDir(), "keybinds.json");
}

function coerce(raw: unknown): KeybindOverrides {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: KeybindOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    // Unknown ids are dropped: a file from another build must not leak into
    // the app, and a malformed entry must not break the keymap.
    if (!BY_ID.has(id) || BY_ID.get(id)?.fixed === true) continue;
    if (!Array.isArray(value)) continue;
    const keys = value.filter((entry): entry is string => typeof entry === "string" && isKnownSpec(entry));
    if (keys.length > 0) out[id] = keys;
  }
  return out;
}

export function loadKeybinds(): KeybindOverrides {
  const path = keybindsPath();
  if (!existsSync(path)) return {};
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export function saveKeybinds(overrides: KeybindOverrides): void {
  const path = keybindsPath();
  const clean = coerce(overrides);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", "utf8");
  } catch {
    // Preferences are best-effort; never break the TUI over a read-only home.
  }
}
