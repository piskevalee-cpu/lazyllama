// Launch configuration: model source + llama-server flags.
// Pure logic (no TUI imports) so it stays unit-testable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
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

// llama.cpp `reasoning_format`: how thinking is returned, independently of
// whether the model thinks at all (see ReasoningEffort).
//   none             — nothing is extracted; thinking stays in the content
//   auto             — same as deepseek, thoughts in `reasoning_content`
//   deepseek         — thoughts in `reasoning_content`, streaming deltas too
//   deepseek-legacy  — `<think>` tags stay in the content while streaming
// Source: llama.cpp common/chat.cpp (common_reasoning_format_from_name) and
// common/common.h. `auto` is the server default, so it is what `null` resolves
// to and the editor only offers the other three explicitly.
export type ReasoningFormat = "none" | "auto" | "deepseek" | "deepseek-legacy";

export const REASONING_FORMATS: ReasoningFormat[] = [
  "none",
  "auto",
  "deepseek",
  "deepseek-legacy",
];

// llama.cpp `reasoning_effort`: the level handed to the chat template, which
// is what actually turns thinking on or off. `none` disables it, a level is
// passed through to the template, and omitting it leaves llama.cpp to detect
// the behaviour from the model ("--reasoning" defaults to auto).
// Source: llama.cpp tools/server/README.md, chat completion parameters.
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Context is the only group that ships a value: `-c` is always sent and `-c 0`
// is llama.cpp's own "take the model's context". Every other tunable is
// nullable, and null means the flag is left out of the command entirely, so
// llama.cpp's documented default applies. `defaultNote` records what that
// default is, so the editor can print it instead of a bare "off".
export interface LaunchConfig {
  model: ModelSource | null; // null = nothing in models/ and no --model flag
  ctxSize: number; // -c/--ctx-size (0 = the model's own context)
  ropeScale: number; // --rope-scale (1 = off, llama.cpp default)
  keepTokens: number; // --keep (0 = off, keep nothing)
  gpuLayers: string | null; // -ngl (number, "auto", "all")
  threads: number | null; // -t
  threadsBatch: number | null; // -tb
  batchSize: number | null; // -b
  ubatchSize: number | null; // -ub
  jinja: boolean | null; // --jinja / --no-jinja
  // Sampling params ride along on chat requests too. null = the parameter is
  // not sent, so llama.cpp's own default (or the model's) decides.
  temp: number | null;
  topP: number | null;
  topK: number | null;
  repeatPenalty: number | null;
  // Two independent layers, both request parameters:
  //   thinking  — whether the model reasons and how hard (reasoning_effort)
  //   reasoning — how the reasoning text comes back (reasoning_format)
  thinking: ReasoningEffort | null;
  reasoning: ReasoningFormat | null;
  extra: string[]; // raw passthrough args, e.g. ["--flash-attn", "off"]
  host: string; // --host, appended by ServerManager, not a launch tunable
  port: number; // --port, ditto
  enableProps: boolean | null; // --props (only needed for POST /props)
  enableMetrics: boolean | null; // --metrics
}

export function defaultConfig(): LaunchConfig {
  return {
    model: null,
    ctxSize: 0,
    ropeScale: 1,
    keepTokens: 0,
    gpuLayers: null,
    threads: null,
    threadsBatch: null,
    batchSize: null,
    ubatchSize: null,
    jinja: null,
    temp: null,
    topP: null,
    topK: null,
    repeatPenalty: null,
    thinking: null,
    reasoning: null,
    extra: [],
    host: "127.0.0.1",
    port: 8080,
    enableProps: null,
    enableMetrics: null,
  };
}

// Build llama-server argv from config. Every nullable tunable is omitted when
// it is null, so the command carries only what was actually chosen and
// llama.cpp's documented default decides the rest. `host`/`port` are appended
// by ServerManager, which is the only place that knows the bind address.
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
  if (cfg.gpuLayers !== null) a.push("-ngl", cfg.gpuLayers);
  if (cfg.threads !== null) a.push("-t", String(cfg.threads));
  if (cfg.threadsBatch !== null) a.push("-tb", String(cfg.threadsBatch));
  if (cfg.batchSize !== null) a.push("-b", String(cfg.batchSize));
  if (cfg.ubatchSize !== null) a.push("-ub", String(cfg.ubatchSize));
  if (cfg.jinja === true) a.push("--jinja");
  if (cfg.jinja === false) a.push("--no-jinja");
  if (cfg.temp !== null) a.push("--temp", String(cfg.temp));
  if (cfg.topP !== null) a.push("--top-p", String(cfg.topP));
  if (cfg.topK !== null) a.push("--top-k", String(cfg.topK));
  if (cfg.repeatPenalty !== null) a.push("--repeat-penalty", String(cfg.repeatPenalty));
  if (cfg.enableProps === true) a.push("--props");
  if (cfg.enableMetrics === true) a.push("--metrics");
  a.push(...cfg.extra);
  return a;
}

// The exact command a config produces, for the in-app manual and the README.
export function effectiveCommand(cfg: LaunchConfig): string {
  try {
    return ["llama-server", ...toServerArgs(cfg)].join(" ");
  } catch {
    return "llama-server (no model selected yet)";
  }
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
  // The value may be left out of the command: `null` is displayed as
  // `default (<defaultNote>)` and the flag / request parameter is omitted
  // entirely instead of being sent with a value.
  optional?: boolean;
  // What llama.cpp falls back to when the value is null, taken from the
  // vendored llama.cpp documentation. Printed by the editor and the manual.
  defaultNote?: string;
  // The value a numeric field switches on to, instead of jumping to its min.
  // A function is resolved at nudge time: threads follow hardware concurrency,
  // exactly as llama.cpp does when the flag is absent. Text fields take their
  // states from `options` and booleans walk on/off, so neither needs this.
  onValue?: number | (() => number);
  // llama.cpp's own auto spelling for this flag, when it has one ("auto" for
  // -ngl, "on|off|auto" for --flash-attn). Only set where the source has it.
  autoValue?: number | string;
}

// Every `defaultNote` below is the documented llama.cpp default for the flag,
// not a guess: see llama.cpp/tools/server/README.md and common/arg.cpp.
export const CONFIG_FIELDS: ConfigFieldDef[] = [
  // Context is the one group that ships a value: `-c 0` is llama.cpp's own
  // "use the model's context", so the flag is always on the command line.
  { key: "ctxSize", label: "context size (-c)", kind: "int", group: "context", min: 0, max: 131072, step: 1024 },
  { key: "ropeScale", label: "rope scale (--rope-scale)", kind: "float", group: "context", min: 0.5, max: 16, step: 0.5 },
  { key: "keepTokens", label: "keep tokens (--keep)", kind: "int", group: "context", min: -1, max: 8192, step: 64 },
  { key: "gpuLayers", label: "gpu layers (-ngl)", kind: "text", group: "launch", options: ["auto", "0", "all"], optional: true, defaultNote: "auto", autoValue: "auto" },
  { key: "threads", label: "threads (-t)", kind: "int", group: "launch", min: 1, max: 256, step: 1, optional: true, defaultNote: "hardware threads", onValue: () => cpus().length },
  { key: "threadsBatch", label: "batch threads (-tb)", kind: "int", group: "launch", min: 1, max: 256, step: 1, optional: true, defaultNote: "hardware threads", onValue: () => cpus().length },
  { key: "batchSize", label: "batch size (-b)", kind: "int", group: "launch", min: 1, max: 8192, step: 256, optional: true, defaultNote: "2048", onValue: 2048 },
  { key: "ubatchSize", label: "micro batch (-ub)", kind: "int", group: "launch", min: 1, max: 4096, step: 128, optional: true, defaultNote: "512", onValue: 512 },
  { key: "jinja", label: "jinja templates (--jinja)", kind: "bool", group: "launch", optional: true, defaultNote: "on" },
  { key: "temp", label: "temperature (--temp)", kind: "float", group: "sampling", min: 0, max: 2, step: 0.1, optional: true, defaultNote: "0.8", onValue: 0.7 },
  { key: "topP", label: "top-p (--top-p)", kind: "float", group: "sampling", min: 0, max: 1, step: 0.05, optional: true, defaultNote: "0.95", onValue: 0.9 },
  { key: "topK", label: "top-k (--top-k)", kind: "int", group: "sampling", min: 0, max: 100, step: 5, optional: true, defaultNote: "40", onValue: 40 },
  { key: "repeatPenalty", label: "repeat penalty (--repeat-penalty)", kind: "float", group: "sampling", min: 0, max: 2, step: 0.1, optional: true, defaultNote: "1.0", onValue: 1.0 },
  // Thinking is two independent layers: the effort the template is given, and
  // how the reasoning text comes back. Both default to the parameter being
  // absent, which is what the app did before it exposed them.
  {
    key: "thinking",
    label: "thinking effort (reasoning_effort)",
    kind: "text",
    group: "sampling",
    // Walked as a dial: from the default, right thinks harder, left stops.
    options: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    optional: true,
    defaultNote: "auto (from the template)",
  },
  {
    key: "reasoning",
    label: "reasoning format (reasoning_format)",
    kind: "text",
    group: "sampling",
    // `auto` is the default state, so only the other three are offered.
    options: ["deepseek", "deepseek-legacy", "none"],
    optional: true,
    defaultNote: "auto",
    autoValue: "auto",
  },
  { key: "host", label: "host (--host)", kind: "text", group: "network" },
  { key: "port", label: "port (--port)", kind: "int", group: "network", min: 1, max: 65535, step: 1 },
  // GET /props is read-only without the flag, so both endpoints default to
  // absent: the app only reads them.
  { key: "enableProps", label: "props endpoint (--props)", kind: "bool", group: "network", optional: true, defaultNote: "off (GET only)" },
  { key: "enableMetrics", label: "metrics endpoint (--metrics)", kind: "bool", group: "network", optional: true, defaultNote: "off" },
  { key: "extra", label: "extra args (raw)", kind: "text", group: "advanced", hint: "space-separated, e.g. --flash-attn off" },
];

type Scalar = string | number | boolean | string[] | null;

function rawField(cfg: LaunchConfig, key: string): Scalar {
  const rec = cfg as unknown as Record<string, Scalar>;
  return rec[key] ?? null;
}

// The values a text field cycles through, with llama.cpp's own auto spelling
// leading when the flag has one.
function fieldOptions(def: ConfigFieldDef): string[] {
  const options = def.options ? [...def.options] : [];
  if (def.autoValue !== undefined && !options.includes(String(def.autoValue))) {
    options.unshift(String(def.autoValue));
  }
  return options;
}

// The full cycle a text field walks: for an optional field the default state
// is one step of the ring, so a value can always be dropped again by walking
// the whole way round.
export function fieldStates(def: ConfigFieldDef): (string | null)[] {
  const options = fieldOptions(def);
  if (def.optional) return [null, ...options];
  return options;
}

// The value a numeric field switches on to: its own `onValue`, or its min for
// the rare field that declares neither.
function optionalOnValue(def: ConfigFieldDef): number {
  const raw = typeof def.onValue === "function" ? def.onValue() : def.onValue;
  if (typeof raw === "number") return def.kind === "float" ? Math.round(raw * 100) / 100 : raw;
  return def.min ?? 0;
}

const FIELD_BY_KEY = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));

export function configField(key: string): ConfigFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

// Display a raw config value the way the editor does, default state included,
// so the side panel and the editor can never disagree about a parameter.
export function configValue(key: string, value: Scalar): string {
  const def = CONFIG_FIELDS.find((field) => field.key === key);
  if (!def) return value === null ? "--" : String(value);
  return fieldDisplay({ [key]: value } as unknown as LaunchConfig, def);
}

// Display value for a field row. A null optional value is the flag being left
// out, so it shows what llama.cpp does instead — never a bare "off".
export function fieldDisplay(cfg: LaunchConfig, def: ConfigFieldDef): string {
  const v = rawField(cfg, def.key);
  if (v === null) {
    if (def.optional) return `default (${def.defaultNote ?? "off"})`;
    return "(none)";
  }
  if (Array.isArray(v)) return v.length > 0 ? v.join(" ") : "(none)";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number" && def.kind === "float") return String(Math.round(v * 100) / 100);
  return String(v);
}

// +/- or left/right: step numbers, toggle bools, cycle text options.
// Optional fields carry the default state (null) as one step of the cycle:
//   up    default -> onValue -> onValue+step ... max -> default
//   down  default -> max -> max-step ... (clamps at min, as always)
// so the flag can always be dropped, and +1 from the default always turns the
// field on. Optional booleans walk default -> on -> off -> default, which is
// the only way to reach the explicit `--no-flag` variants.
export function nudgeField(cfg: LaunchConfig, def: ConfigFieldDef, dir: 1 | -1): LaunchConfig {
  const next: LaunchConfig = { ...cfg, extra: [...cfg.extra] };
  const rec = next as unknown as Record<string, Scalar>;
  const v = rawField(cfg, def.key);
  const numeric = def.kind === "int" || def.kind === "float";
  if (def.optional && def.kind === "bool") {
    // Three states in a ring: the flag is not sent, then `--flag`, then
    // `--no-flag`. The last one is unreachable by typing "off", which drops
    // the flag, so the arrow keys are the only way to ask for it.
    const states: Scalar[] = [null, true, false];
    const at = v === true || v === false ? states.indexOf(v) : 0;
    rec[def.key] = states[(at + dir + states.length) % states.length] ?? null;
    return next;
  }
  if (def.optional && def.kind === "text") {
    // The ring includes the default state, so a value set with the arrow keys
    // can be dropped again by walking all the way round.
    const states = fieldStates(def);
    if (states.length <= 1) return next;
    const at = v === null ? 0 : Math.max(0, states.indexOf(typeof v === "string" ? v : ""));
    rec[def.key] = states[(at + dir + states.length) % states.length] ?? null;
    return next;
  }
  if (def.optional && numeric) {
    if (v === null) {
      // -1 from the default wraps to the top of the range; +1 enables it.
      rec[def.key] = dir === 1 ? optionalOnValue(def) : (def.max ?? optionalOnValue(def));
      return next;
    }
    if (typeof v === "number" && def.max !== undefined && v >= def.max && dir === 1) {
      rec[def.key] = null; // stepping past max drops the flag again
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
// "default"/"auto"/"none"/blank drops the flag; anything numeric enables it.
// Booleans keep all three states, so an explicit `--no-flag` stays reachable.
export function applyFieldEdit(cfg: LaunchConfig, def: ConfigFieldDef, text: string): LaunchConfig {
  const next: LaunchConfig = { ...cfg, extra: [...cfg.extra] };
  const rec = next as unknown as Record<string, Scalar>;
  const t = text.trim();
  if (def.key === "extra") {
    rec["extra"] = t.length > 0 ? t.split(/\s+/) : [];
    return next;
  }
  if (def.optional && def.kind === "bool") {
    if (t.length === 0 || /^(default|auto|none)$/i.test(t)) rec[def.key] = null;
    else if (/^(on|true|1|yes)$/i.test(t)) rec[def.key] = true;
    else if (/^(off|false|0|no)$/i.test(t)) rec[def.key] = false;
    return next;
  }
  if (def.optional && t.length > 0 && /^(default|auto|none|off)$/i.test(t)) {
    rec[def.key] = null;
    return next;
  }
  if (def.optional && t.length === 0) {
    rec[def.key] = null;
    return next;
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
  rec[def.key] = t;
  return next;
}
