// Launch configuration: model source + llama-server flags.
// Pure logic (no TUI imports) so it stays unit-testable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

export type ModelSource =
  | { kind: "local"; path: string }
  | { kind: "hf"; repo: string; file?: string };

export function modelId(src: ModelSource): string {
  if (src.kind === "local") return `local:${src.path}`;
  return `hf:${src.repo}${src.file ? `:${src.file}` : ""}`;
}

export function abbreviateHome(path: string, home: string = homedir()): string {
  if (home.length === 0 || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest.length === 0) return "~";
  if (!rest.startsWith("/")) return path;
  return `~${rest}`;
}

export function modelDisplayName(src: ModelSource | null): string {
  if (!src) return "(no model)";
  if (src.kind === "hf") return src.file ? `${src.repo}:${src.file}` : src.repo;
  const file = basename(src.path);
  const extension = extname(file);
  return extension.length > 0 ? file.slice(0, -extension.length) : file;
}

export function modelSourceLabel(src: ModelSource | null): string {
  if (!src) return "";
  return src.kind === "local" ? "local" : "huggingface";
}

export type ReasoningFormat = "auto" | "none";

export const REASONING_FORMATS: ReasoningFormat[] = ["auto", "none"];

// Numeric sentinels, not nulls: these tunables have a numeric value that
// already means "off"/"auto" and the flag is always sent, so they keep plain
// `number` fields. Only the sampling params below are nullable.
export interface LaunchConfig {
  model: ModelSource | null; // null = nothing in models/ and no --model flag
  ctxSize: number; // -c/--ctx-size (0 = off, take the model's context)
  ropeScale: number; // --rope-scale (1 = off, llama.cpp default)
  keepTokens: number; // --keep (0 = off, keep nothing)
  gpuLayers: string; // -ngl (number, "auto", "all")
  threads: number; // -t (-1 = off, auto)
  threadsBatch: number; // -tb (-1 = off, same as threads)
  batchSize: number; // -b
  ubatchSize: number; // -ub
  jinja: boolean; // --jinja / --no-jinja
  // Sampling params are nullable: null = off, and off means the flag is
  // omitted entirely, so llama.cpp falls back to the model's own default.
  temp: number | null;
  topP: number | null;
  topK: number | null;
  repeatPenalty: number | null;
  // llama.cpp `reasoning_format`: "auto" splits model thinking into
  // `reasoning_content` deltas, "none" leaves it inline in the content.
  reasoning: ReasoningFormat;
  extra: string[]; // raw passthrough args, e.g. ["--flash-attn", "off"]
  host: string;
  port: number;
  enableProps: boolean; // --props (needed for POST /props)
  enableMetrics: boolean; // --metrics (needed for /metrics)
}

export function defaultConfig(): LaunchConfig {
  return {
    model: null,
    ctxSize: 0,
    ropeScale: 1,
    keepTokens: 0,
    gpuLayers: "auto",
    threads: -1,
    threadsBatch: -1,
    batchSize: 2048,
    ubatchSize: 512,
    jinja: true,
    temp: 0.7,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.0,
    reasoning: "auto",
    extra: [],
    host: "127.0.0.1",
    port: 8080,
    enableProps: true,
    enableMetrics: true,
  };
}

// Build llama-server argv from config. Sampling params ride along on
// chat requests too, but baking defaults here keeps CLI parity. A null
// sampling param is off: the flag is left out so the server default wins.
export function toServerArgs(cfg: LaunchConfig): string[] {
  if (!cfg.model) {
    throw new Error("no model configured — drop a .gguf into models/ or pass --model");
  }
  const a: string[] = [];
  if (cfg.model.kind === "local") {
    a.push("-m", cfg.model.path);
  } else {
    a.push("-hf", cfg.model.repo);
    if (cfg.model.file) a.push("--hf-file", cfg.model.file);
  }
  a.push("-c", String(cfg.ctxSize));
  if (cfg.ropeScale !== 1) a.push("--rope-scale", String(cfg.ropeScale));
  if (cfg.keepTokens !== 0) a.push("--keep", String(cfg.keepTokens));
  a.push("-ngl", cfg.gpuLayers);
  a.push("-t", String(cfg.threads));
  if (cfg.threadsBatch >= 0) a.push("-tb", String(cfg.threadsBatch));
  a.push("-b", String(cfg.batchSize), "-ub", String(cfg.ubatchSize));
  a.push(cfg.jinja ? "--jinja" : "--no-jinja");
  if (cfg.temp !== null) a.push("--temp", String(cfg.temp));
  if (cfg.topP !== null) a.push("--top-p", String(cfg.topP));
  if (cfg.topK !== null) a.push("--top-k", String(cfg.topK));
  if (cfg.repeatPenalty !== null) a.push("--repeat-penalty", String(cfg.repeatPenalty));
  if (cfg.enableProps) a.push("--props");
  if (cfg.enableMetrics) a.push("--metrics");
  a.push(...cfg.extra);
  return a;
}

// Per-model presets persisted under ~/.config/lazyllama/presets.json
// LAZYLLAMA_CONFIG_DIR overrides the location (used by tests and sandboxes).
export function configDir(): string {
  const override = process.env["LAZYLLAMA_CONFIG_DIR"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".config", "lazyllama");
}

export function presetsPath(): string {
  return join(configDir(), "presets.json");
}

type PresetFile = Record<string, Partial<LaunchConfig>>;

function readPresets(): PresetFile {
  const p = presetsPath();
  if (!existsSync(p)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as PresetFile;
    }
    return {};
  } catch {
    return {};
  }
}

export function loadPreset(id: string): Partial<LaunchConfig> | undefined {
  return readPresets()[id];
}

export function savePreset(id: string, cfg: LaunchConfig): void {
  const p = presetsPath();
  const all = readPresets();
  const { host: _h, port: _p, ...rest } = cfg;
  all[id] = rest;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(all, null, 2) + "\n", "utf8");
}

// -- hub editor: every tunable as data ----------------------------------
// The hub config screen renders CONFIG_FIELDS generically; add a row here
// and it appears in the UI with keyboard editing for free.

export type ConfigFieldKind = "int" | "float" | "text" | "bool";

export type ConfigFieldGroup = "context" | "launch" | "sampling" | "network" | "advanced";

export const CONFIG_GROUP_ORDER: ConfigFieldGroup[] = [
  "context",
  "launch",
  "sampling",
  "network",
  "advanced",
];

export const CONFIG_GROUP_TITLES: Record<ConfigFieldGroup, string> = {
  context: "Context",
  launch: "Launch",
  sampling: "Sampling",
  network: "Network",
  advanced: "Advanced",
};

export interface ConfigFieldDef {
  key: string;
  label: string;
  kind: ConfigFieldKind;
  group: ConfigFieldGroup;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // text fields cycle these on left/right
  hint?: string;
  // Value may be switched off: `null` displays as "off" and the flag /
  // request parameter is omitted entirely instead of being sent with a value.
  optional?: boolean;
}

export const CONFIG_FIELDS: ConfigFieldDef[] = [
  { key: "ctxSize", label: "context size (-c)", kind: "int", group: "context", min: 0, max: 131072, step: 1024 },
  { key: "ropeScale", label: "rope scale", kind: "float", group: "context", min: 0.5, max: 16, step: 0.5 },
  { key: "keepTokens", label: "keep tokens (--keep)", kind: "int", group: "context", min: -1, max: 8192, step: 64 },
  { key: "gpuLayers", label: "gpu layers (-ngl)", kind: "text", group: "launch", options: ["auto", "0", "all"] },
  { key: "threads", label: "threads (-t, -1=auto)", kind: "int", group: "launch", min: -1, max: 256, step: 1 },
  { key: "threadsBatch", label: "batch threads (-tb)", kind: "int", group: "launch", min: -1, max: 256, step: 1 },
  { key: "batchSize", label: "batch size (-b)", kind: "int", group: "launch", min: 1, max: 8192, step: 256 },
  { key: "ubatchSize", label: "micro batch (-ub)", kind: "int", group: "launch", min: 1, max: 4096, step: 128 },
  { key: "jinja", label: "jinja templates", kind: "bool", group: "launch" },
  { key: "temp", label: "temperature", kind: "float", group: "sampling", min: 0, max: 2, step: 0.1, optional: true },
  { key: "topP", label: "top-p", kind: "float", group: "sampling", min: 0, max: 1, step: 0.05, optional: true },
  { key: "topK", label: "top-k", kind: "int", group: "sampling", min: 0, max: 100, step: 5, optional: true },
  { key: "repeatPenalty", label: "repeat penalty", kind: "float", group: "sampling", min: 0, max: 2, step: 0.1, optional: true },
  { key: "reasoning", label: "thinking (reasoning_format)", kind: "text", group: "sampling", options: ["auto", "none"] },
  { key: "host", label: "host", kind: "text", group: "network" },
  { key: "port", label: "port", kind: "int", group: "network", min: 1, max: 65535, step: 1 },
  { key: "enableProps", label: "props endpoint (--props)", kind: "bool", group: "network" },
  { key: "enableMetrics", label: "metrics endpoint (--metrics)", kind: "bool", group: "network" },
  { key: "extra", label: "extra args (raw)", kind: "text", group: "advanced", hint: "space-separated, e.g. --flash-attn off" },
];

type Scalar = string | number | boolean | string[] | null;

function rawField(cfg: LaunchConfig, key: string): Scalar {
  const rec = cfg as unknown as Record<string, Scalar>;
  return rec[key] ?? null;
}

// Value an optional field switches on to: the shipped default, or the field's
// min when the default is not numeric (every current default is in range).
function optionalOnValue(def: ConfigFieldDef): number {
  const raw = (defaultConfig() as unknown as Record<string, unknown>)[def.key];
  const base = typeof raw === "number" ? raw : (def.min ?? 0);
  return def.kind === "float" ? Math.round(base * 100) / 100 : base;
}

// Display value for a field row.
export function fieldDisplay(cfg: LaunchConfig, def: ConfigFieldDef): string {
  const v = rawField(cfg, def.key);
  if (v === null) return def.optional ? "off" : "(none)";
  if (Array.isArray(v)) return v.length > 0 ? v.join(" ") : "(none)";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number" && def.kind === "float") return String(Math.round(v * 100) / 100);
  return String(v);
}

// +/- or left/right: step numbers, toggle bools, cycle text options.
// Optional numeric fields carry `off` (null) as the first state of the cycle:
//   up   off -> default -> default+step ... max -> off
//   down off -> max -> max-step ... (clamps at min, as non-optional fields do)
// so off is always reachable and +1 from off always turns the field on.
export function nudgeField(cfg: LaunchConfig, def: ConfigFieldDef, dir: 1 | -1): LaunchConfig {
  const next: LaunchConfig = { ...cfg, extra: [...cfg.extra] };
  const rec = next as unknown as Record<string, Scalar>;
  const v = rawField(cfg, def.key);
  const numeric = def.kind === "int" || def.kind === "float";
  if (def.optional && numeric) {
    if (v === null) {
      // -1 from off wraps to the top of the range; +1 enables at the default.
      rec[def.key] = dir === 1 ? optionalOnValue(def) : (def.max ?? optionalOnValue(def));
      return next;
    }
    if (typeof v === "number" && def.max !== undefined && v >= def.max && dir === 1) {
      rec[def.key] = null; // stepping past max switches off
      return next;
    }
  }
  if (def.kind === "bool") {
    rec[def.key] = !(v === true);
    return next;
  }
  if (def.kind === "int" && typeof v === "number") {
    const step = def.step ?? 1;
    let n = v + dir * step;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    rec[def.key] = n;
    return next;
  }
  if (def.kind === "float" && typeof v === "number") {
    const step = def.step ?? 0.1;
    let n = Math.round((v + dir * step) * 100) / 100;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    rec[def.key] = n;
    return next;
  }
  if (def.kind === "text" && def.options && def.options.length > 0) {
    const cur = typeof v === "string" ? v : "";
    const i = def.options.indexOf(cur);
    const n = dir === 1 ? (i + 1) % def.options.length : (i - 1 + def.options.length) % def.options.length;
    rec[def.key] = def.options[n] ?? cur;
    return next;
  }
  return next;
}

// Commit a typed string (Enter in the inline editor). On an optional field
// "off"/"none"/blank switches the value off (null); anything numeric enables it.
export function applyFieldEdit(cfg: LaunchConfig, def: ConfigFieldDef, text: string): LaunchConfig {
  const next: LaunchConfig = { ...cfg, extra: [...cfg.extra] };
  const rec = next as unknown as Record<string, Scalar>;
  const t = text.trim();
  if (def.key === "extra") {
    rec["extra"] = t.length > 0 ? t.split(/\s+/) : [];
    return next;
  }
  if (def.optional && (def.kind === "int" || def.kind === "float")) {
    if (t.length === 0 || /^(off|none)$/i.test(t)) {
      rec[def.key] = null;
      return next;
    }
  }
  if (def.kind === "int") {
    const n = Number.parseInt(t, 10);
    if (!Number.isNaN(n)) {
      rec[def.key] = def.min !== undefined ? Math.max(def.min, n) : n;
      if (typeof rec[def.key] === "number" && def.max !== undefined) {
        rec[def.key] = Math.min(def.max, rec[def.key] as number);
      }
    }
    return next;
  }
  if (def.kind === "float") {
    const n = Number.parseFloat(t);
    if (!Number.isNaN(n)) {
      let c = n;
      if (def.min !== undefined) c = Math.max(def.min, c);
      if (def.max !== undefined) c = Math.min(def.max, c);
      rec[def.key] = c;
    }
    return next;
  }
  if (def.kind === "bool") {
    if (/^(on|true|1|yes)$/i.test(t)) rec[def.key] = true;
    else if (/^(off|false|0|no)$/i.test(t)) rec[def.key] = false;
    return next;
  }
  rec[def.key] = t;
  return next;
}
