// User settings that outlive a single launch: which models directory to scan,
// which backend was installed, and where the `lazyllama` launcher landed.
// Kept out of model presets: presets are per-model launch config, this is
// machine setup.
//
// Precedence for every value is env var -> settings.json -> built-in default,
// so a shell export always wins and the app still works with no settings file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configDir } from "./config.js";
import type { Backend } from "./backends.js";

export interface Settings {
  /** Directory scanned for .gguf models. `~` is expanded on read. */
  modelsDir?: string;
  /** Backend the installer provisioned, for display and for re-installs. */
  backend?: Backend;
  /** Absolute path of the installed `lazyllama` launcher. */
  launcher?: string;
  /** ISO timestamp of the last successful install. */
  installedAt?: string;
}

/** The default location the installer offers: `~/lazyllama-models`. */
export const DEFAULT_MODELS_DIR_NAME = "lazyllama-models";

export function defaultModelsDir(home: string = homedir()): string {
  return join(home, DEFAULT_MODELS_DIR_NAME);
}

/** `~/x` and `~` become absolute; everything else is resolved against cwd. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.length === 0) return path;
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

export function settingsPath(): string {
  return join(configDir(), "settings.json");
}

function coerce(raw: unknown): Settings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const out: Settings = {};
  if (typeof rec["modelsDir"] === "string" && rec["modelsDir"].length > 0) out.modelsDir = rec["modelsDir"];
  if (typeof rec["backend"] === "string") out.backend = rec["backend"] as Backend;
  if (typeof rec["launcher"] === "string" && rec["launcher"].length > 0) out.launcher = rec["launcher"];
  if (typeof rec["installedAt"] === "string" && rec["installedAt"].length > 0) out.installedAt = rec["installedAt"];
  return out;
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export function writeSettings(patch: Settings): Settings {
  const path = settingsPath();
  const next = { ...readSettings(), ...patch };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // Settings are best-effort: a read-only home must not break the app.
  }
  return next;
}

/**
 * Where models live: LAZYLLAMA_MODELS_DIR wins, then the installer's choice,
 * then the repo-relative models/ so a fresh clone still works.
 */
export function resolveModelsDir(cwd: string = process.cwd(), home: string = homedir()): string {
  const fromEnv = process.env["LAZYLLAMA_MODELS_DIR"];
  if (fromEnv && fromEnv.length > 0) return expandHome(fromEnv, home);
  const stored = readSettings().modelsDir;
  if (stored && stored.length > 0) return expandHome(stored, home);
  return join(cwd, "models");
}
