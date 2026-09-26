// Key handling: canonical name normalization, OpenCode-style binding specs and
// a small mode/scope aware keymap. The renderer dispatches global keypress
// listeners before the focused renderable, so this module owns layering and
// lets unclaimed keys fall through to the focused editor.

import type { KeyEvent } from "@opentui/core";

const ENTER_KEY_NAMES = ["return", "enter", "kpenter", "linefeed"] as const;

// Alias map replicates OpenCode's keymap normalization: component bindings may
// spell these differently, but application logic compares canonical names.
const KEY_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  space: "space",
};

export function canonicalKeyName(name: string): string {
  return KEY_ALIASES[name] ?? name;
}

export function isEnterKey(key: Pick<KeyEvent, "name">): boolean {
  return (ENTER_KEY_NAMES as readonly string[]).includes(key.name);
}

export function isEscapeKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name === "escape" || key.name === "esc";
}

export function isQuitKey(key: Pick<KeyEvent, "name" | "ctrl">): boolean {
  return key.name === "c" && key.ctrl === true;
}

export function isTabForward(key: Pick<KeyEvent, "name" | "shift">): boolean {
  return key.name === "tab" && key.shift !== true;
}

export function isTabBackward(key: Pick<KeyEvent, "name" | "shift">): boolean {
  return key.name === "tab" && key.shift === true;
}

export function isUpKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name === "up" || key.name === "k";
}

export function isDownKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name === "down" || key.name === "j";
}

export function isLeftKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name === "left" || key.name === "-";
}

export function isRightKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name === "right" || key.name === "+" || key.name === "=";
}

export interface KeySpec {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  super?: boolean;
}

const MODIFIER_ALIASES: Record<string, keyof Omit<KeySpec, "name">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "super",
  win: "super",
};

// "ctrl+alt+b", "shift+return", "escape" -> structured spec.
export function parseKeySpec(spec: string): KeySpec {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const parsed: KeySpec = { name: "" };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier !== undefined) {
      parsed[modifier] = true;
      continue;
    }
    parsed.name = canonicalKeyName(part);
  }
  return parsed;
}

export function matchesKeySpec(key: KeyEvent, spec: string): boolean {
  const want = parseKeySpec(spec);
  if (canonicalKeyName(key.name) !== want.name) return false;
  if (want.ctrl === true && key.ctrl !== true) return false;
  if (want.shift === true && key.shift !== true) return false;
  if (want.alt === true && key.option !== true) return false;
  if (want.meta === true && key.meta !== true) return false;
  if (want.super === true && key.super !== true) return false;
  // Unqualified modifiers must not be set, so "escape" never fires on
  // ctrl+escape and "b" never fires on ctrl+b.
  if (want.ctrl !== true && key.ctrl === true) return false;
  if (want.shift !== true && key.shift === true && want.name !== "space") return false;
  if (want.alt !== true && key.option === true) return false;
  if (want.meta !== true && key.meta === true) return false;
  if (want.super !== true && key.super === true) return false;
  return true;
}

/** Which keys may run: always, only with an editor focused, or only without. */
export type BindingScope = "global" | "editor" | "unfocused";

/** Mode stack entry. Only the top mode's bindings are eligible. */
export type KeymapMode = "base" | "modal";

export interface KeymapContext {
  editorFocused: boolean;
}

export interface Binding {
  id: string;
  /** Specs such as "ctrl+b" or "escape"; any match runs the command. */
  keys: string[];
  /** Human label used to build footer hints from the registry. */
  description: string;
  scope?: BindingScope;
  modes?: KeymapMode[];
  when?: () => boolean;
  run: (key: KeyEvent) => void;
}

export class Keymap {
  private readonly bindings: Binding[] = [];
  private readonly modes: KeymapMode[] = ["base"];

  register(bindings: Binding[]): void {
    for (const binding of bindings) this.bindings.push(binding);
  }

  get mode(): KeymapMode {
    return this.modes[this.modes.length - 1] ?? "base";
  }

  get isModal(): boolean {
    return this.mode === "modal";
  }

  pushMode(mode: KeymapMode): void {
    this.modes.push(mode);
  }

  popMode(): void {
    if (this.modes.length > 1) this.modes.pop();
  }

  private eligible(binding: Binding, ctx: KeymapContext): boolean {
    if (binding.when !== undefined && !binding.when()) return false;
    const modes = binding.modes ?? ["base"];
    if (!modes.includes(this.mode)) return false;
    const scope = binding.scope ?? "global";
    if (scope === "editor" && !ctx.editorFocused) return false;
    if (scope === "unfocused" && ctx.editorFocused) return false;
    return true;
  }

  /** Returns true when a binding claimed the key. */
  handle(key: KeyEvent, ctx: KeymapContext): boolean {
    for (const binding of this.bindings) {
      if (!this.eligible(binding, ctx)) continue;
      if (!binding.keys.some((spec) => matchesKeySpec(key, spec))) continue;
      binding.run(key);
      return true;
    }
    return false;
  }

  /** Ids of bindings currently eligible, for hint text generation. */
  activeIds(ctx: KeymapContext): string[] {
    return this.bindings.filter((binding) => this.eligible(binding, ctx)).map((b) => b.id);
  }
}
