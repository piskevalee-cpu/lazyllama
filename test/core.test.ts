// Pure-logic tests: config args, ASCII helpers, perf formatting.
// Renderer behavior is covered separately in test/ui.test.ts.

import { describe, expect, test } from "bun:test";
import { readSlotContext } from "../src/perf.ts";
import { gradientFill, sweepFill } from "../src/ui/meter.ts";
import {
  CONFIG_FIELDS,
  CONFIG_GROUP_ORDER,
  CONFIG_GROUP_TITLES,
  abbreviateHome,
  applyFieldEdit,
  configValue,
  defaultConfig,
  effectiveCommand,
  fieldDisplay,
  fieldStates,
  modelDisplayName,
  modelId,
  modelSourceLabel,
  nudgeField,
  toServerArgs,
} from "../src/config.ts";
import { MANUAL_ENTRY_COUNT, MANUAL_GROUPS, manualEntryFor, manualFieldKeys } from "../src/manual.ts";
import { buildModelEntries, entryLabel, selectableEntries } from "../src/hub.ts";
import { logoLines, splashFrame, splashGlintSweep } from "../src/splash.ts";
import { LAZYLLAMA_LOGO } from "../src/logo.ts";
import { hbar, pct, thinkingDots } from "../src/ascii.ts";

describe("model ids", () => {
  test("local and hf ids are distinct", () => {
    expect(modelId({ kind: "local", path: "/m/q.gguf" })).toBe("local:/m/q.gguf");
    expect(modelId({ kind: "hf", repo: "u/m" })).toBe("hf:u/m");
    expect(modelId({ kind: "hf", repo: "u/m", file: "q4.gguf" })).toBe("hf:u/m:q4.gguf");
  });
  test("header labels use short model names and sources", () => {
    expect(modelDisplayName({ kind: "local", path: "/models/MiniCPM5-Q4_K_M.gguf" })).toBe(
      "MiniCPM5-Q4_K_M",
    );
    expect(modelDisplayName({ kind: "hf", repo: "u/m", file: "q4.gguf" })).toBe("u/m:q4.gguf");
    expect(modelDisplayName(null)).toBe("(no model)");
    expect(modelSourceLabel({ kind: "local", path: "/m/q.gguf" })).toBe("local");
    expect(modelSourceLabel({ kind: "hf", repo: "u/m" })).toBe("huggingface");
    expect(modelSourceLabel(null)).toBe("");
  });
  test("home directories abbreviate without matching partial names", () => {
    expect(abbreviateHome("/home/valerio/Projects/x.gguf", "/home/valerio")).toBe(
      "~/Projects/x.gguf",
    );
    expect(abbreviateHome("/home/valerio", "/home/valerio")).toBe("~");
    expect(abbreviateHome("/home/valerio2/x.gguf", "/home/valerio")).toBe("/home/valerio2/x.gguf");
    expect(abbreviateHome("/models/x.gguf", "")).toBe("/models/x.gguf");
  });
});

describe("server args", () => {
  test("no model by default; toServerArgs throws until one is set", () => {
    expect(defaultConfig().model).toBeNull();
    expect(() => toServerArgs(defaultConfig())).toThrow(/no model/);
  });
  test("hf model maps to -hf, and the endpoint flags stay off by default", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "hf", repo: "ggml-org/Qwen3.5-0.8B-GGUF" };
    const args = toServerArgs(cfg);
    expect(args).toContain("-hf");
    expect(args).toContain("ggml-org/Qwen3.5-0.8B-GGUF");
    // GET /props is read-only without the flag, so nothing is sent for either
    // endpoint until the user asks for it.
    expect(args).not.toContain("--props");
    expect(args).not.toContain("--metrics");
    cfg.enableProps = true;
    cfg.enableMetrics = true;
    const withEndpoints = toServerArgs(cfg);
    expect(withEndpoints).toContain("--props");
    expect(withEndpoints).toContain("--metrics");
  });
  test("local model maps to -m and rope-scale omitted at 1", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    const args = toServerArgs(cfg);
    expect(args).toContain("-m");
    expect(args).not.toContain("--rope-scale");
    cfg.ropeScale = 2;
    expect(toServerArgs(cfg)).toContain("--rope-scale");
  });
  test("extra passthrough appended last", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    cfg.extra = ["--flash-attn", "off"];
    const args = toServerArgs(cfg);
    expect(args.slice(-2)).toEqual(["--flash-attn", "off"]);
  });
  test("the default config puts only the model and the context on the command", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    expect(toServerArgs(cfg)).toEqual(["-m", "/models/q.gguf", "-c", "0"]);
  });
  test("every nullable tunable drops its flag when it is null", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    const args = toServerArgs(cfg);
    for (const flag of [
      "-ngl",
      "-t",
      "-tb",
      "-b",
      "-ub",
      "--jinja",
      "--no-jinja",
      "--temp",
      "--top-p",
      "--top-k",
      "--repeat-penalty",
      "--props",
      "--metrics",
      "--rope-scale",
      "--keep",
    ]) {
      expect(args).not.toContain(flag);
    }
  });
  test("set tunables keep their flags and order", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    cfg.gpuLayers = "all";
    cfg.threads = 6;
    cfg.threadsBatch = 4;
    cfg.batchSize = 4096;
    cfg.ubatchSize = 256;
    cfg.jinja = false;
    cfg.temp = 0.7;
    cfg.topP = 0.9;
    cfg.topK = 30;
    cfg.repeatPenalty = 1.1;
    const args = toServerArgs(cfg);
    const order = ["-ngl", "-t", "-tb", "-b", "-ub", "--no-jinja", "--temp", "--top-p", "--top-k"];
    for (const flag of order) expect(args).toContain(flag);
    const at = order.map((flag) => args.indexOf(flag));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(args[args.indexOf("-ngl") + 1]).toBe("all");
    expect(args[args.indexOf("-t") + 1]).toBe("6");
    expect(args[args.indexOf("--temp") + 1]).toBe("0.7");
    expect(args[args.indexOf("--top-p") + 1]).toBe("0.9");
    expect(args[args.indexOf("--top-k") + 1]).toBe("30");
    expect(args[args.indexOf("--repeat-penalty") + 1]).toBe("1.1");
  });
  test("the effective command is the argv, for the manual header", () => {
    const cfg = defaultConfig();
    expect(effectiveCommand(cfg)).toBe("llama-server (no model selected yet)");
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    expect(effectiveCommand(cfg)).toBe("llama-server -m /models/q.gguf -c 0");
  });
});

describe("ascii helpers", () => {
  test("hbar clamps and fills", () => {
    expect(hbar(0.5, 10)).toBe("█████░░░░░");
    expect(hbar(2, 4)).toBe("████");
    expect(hbar(-1, 4)).toBe("░░░░");
  });
  test("pct rounds", () => {
    expect(pct(0.256)).toBe("26%");
  });
  test("thinking dots stays 3 wide", () => {
    for (let i = 0; i < 8; i += 1) expect(thinkingDots(i).length).toBe(3);
  });
});

describe("meters", () => {
  test("the gradient fill fades through the ramp and keeps a dim track", () => {
    const meter = { ramp: ["#ffffff", "#b4b4b4", "#6e6e6e"] as [string, string, string], track: "#242424" };
    const full = gradientFill(1, 9, meter);
    expect(full.map((chunk) => chunk.text).join("")).toBe("\u2588".repeat(9));
    expect(full.some((chunk) => String(chunk.fg).includes("1.00"))).toBe(true);
    // A partial fill leaves the rest of the track dimmed.
    const half = gradientFill(0.5, 10, meter);
    const glyphs = half.map((chunk) => chunk.text).join("");
    expect(glyphs).toBe("\u2588".repeat(5) + "\u2591".repeat(5));
    expect(gradientFill(0, 4, meter).map((chunk) => chunk.text).join("")).toBe("\u2591".repeat(4));
  });

  test("the loading sweep keeps its width while it travels", () => {
    const meter = { ramp: ["#ffffff", "#b4b4b4", "#6e6e6e"] as [string, string, string], track: "#242424" };
    for (const elapsed of [0, 240, 900, 3000]) {
      const glyphs = sweepFill(elapsed, 28, meter)
        .map((chunk) => chunk.text)
        .join("");
      expect(glyphs.length).toBe(28);
    }
    // It must actually move.
    const a = sweepFill(0, 28, meter).map((chunk) => chunk.text).join("");
    const b = sweepFill(600, 28, meter).map((chunk) => chunk.text).join("");
    expect(a).not.toBe(b);
  });
});

describe("live slot context", () => {
  test("reads prompt plus generated tokens from a slots payload", () => {
    const payload = [
      {
        id: 0,
        n_ctx: 8192,
        is_processing: true,
        n_prompt_tokens: 300,
        n_prompt_tokens_processed: 40,
        n_prompt_tokens_cache: 260,
        next_token: { n_decoded: 25 },
      },
    ];
    expect(readSlotContext(payload)).toEqual({ used: 325, total: 8192, processing: true });
  });

  test("falls back to alternative field names and stays defensive", () => {
    expect(
      readSlotContext([{ n_ctx: 4096, n_prompt_tokens: 100, n_decoded: 7, is_processing: false }]),
    ).toEqual({ used: 107, total: 4096, processing: false });
    expect(readSlotContext([{}])).toBeUndefined();
    expect(readSlotContext([])).toBeUndefined();
    expect(readSlotContext("nope")).toBeUndefined();
  });
});

describe("config fields", () => {
  test("every tunable LaunchConfig key is covered", () => {
    const keys = CONFIG_FIELDS.map((f) => f.key).sort();
    const expected = [
      "batchSize",
      "ctxSize",
      "enableMetrics",
      "enableProps",
      "extra",
      "gpuLayers",
      "host",
      "jinja",
      "keepTokens",
      "port",
      "reasoning",
      "repeatPenalty",
      "ropeScale",
      "temp",
      "thinking",
      "threads",
      "threadsBatch",
      "topK",
      "topP",
      "ubatchSize",
    ].sort();
    expect(keys).toEqual(expected);
  });
  test("every tunable belongs to a named editor group", () => {
    expect(CONFIG_GROUP_ORDER).toEqual(["context", "launch", "sampling", "network", "advanced"]);
    expect(new Set(CONFIG_FIELDS.map((field) => field.group))).toEqual(new Set(CONFIG_GROUP_ORDER));
    for (const group of CONFIG_GROUP_ORDER) {
      expect(CONFIG_GROUP_TITLES[group].length).toBeGreaterThan(0);
      expect(CONFIG_FIELDS.some((field) => field.group === group)).toBe(true);
    }
  });
  test("nudge steps ints, cycles text options and walks booleans", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/m/q.gguf" };
    const ctx = CONFIG_FIELDS.find((f) => f.key === "ctxSize")!;
    expect(fieldDisplay(nudgeField(cfg, ctx, 1), ctx)).toBe("1024");
    // Booleans have three states, so the explicit --no-flag is reachable.
    const jinja = CONFIG_FIELDS.find((f) => f.key === "jinja")!;
    const on = nudgeField(cfg, jinja, 1);
    expect(fieldDisplay(on, jinja)).toBe("on");
    expect(fieldDisplay(nudgeField(on, jinja, 1), jinja)).toBe("off");
    expect(fieldDisplay(nudgeField(nudgeField(on, jinja, 1), jinja, 1), jinja)).toBe("default (on)");
    // Text fields cycle their options and wrap back to the default state.
    const ngl = CONFIG_FIELDS.find((f) => f.key === "gpuLayers")!;
    const auto = nudgeField(cfg, ngl, 1);
    expect(fieldDisplay(auto, ngl)).toBe("auto");
    expect(fieldDisplay(nudgeField(auto, ngl, 1), ngl)).toBe("0");
    expect(fieldDisplay(nudgeField(nudgeField(auto, ngl, 1), ngl, 1), ngl)).toBe("all");
    expect(fieldDisplay(nudgeField(nudgeField(nudgeField(auto, ngl, 1), ngl, 1), ngl, 1), ngl)).toBe(
      "default (auto)",
    );
  });
  test("nudge clamps to min/max", () => {
    const cfg = defaultConfig();
    const port = CONFIG_FIELDS.find((f) => f.key === "port")!;
    expect(nudgeField({ ...cfg, port: 65535 }, port, 1).port).toBe(65535);
    expect(nudgeField({ ...cfg, port: 1 }, port, -1).port).toBe(1);
  });
  test("applyFieldEdit parses typed input", () => {
    const cfg = defaultConfig();
    const temp = CONFIG_FIELDS.find((f) => f.key === "temp")!;
    expect(applyFieldEdit(cfg, temp, "0.9").temp).toBe(0.9);
    expect(applyFieldEdit(cfg, temp, "junk").temp).toBe(cfg.temp);
    const extra = CONFIG_FIELDS.find((f) => f.key === "extra")!;
    expect(applyFieldEdit(cfg, extra, "--flash-attn off").extra).toEqual(["--flash-attn", "off"]);
    expect(applyFieldEdit(cfg, extra, "   ").extra).toEqual([]);
  });
});

describe("optional parameters", () => {
  // Everything outside the context group, and the address fields, can be left
  // off: a null value means the flag is not in the command at all.
  const OPTIONAL_KEYS = CONFIG_FIELDS.filter((f) => f.optional).map((f) => f.key);
  const ALWAYS_SENT = CONFIG_FIELDS.filter((f) => !f.optional).map((f) => f.key);

  function def(key: string) {
    return CONFIG_FIELDS.find((f) => f.key === key)!;
  }

  test("only the context group and the address fields are not optional", () => {
    expect(ALWAYS_SENT.sort()).toEqual(["ctxSize", "extra", "host", "keepTokens", "port", "ropeScale"].sort());
    for (const key of OPTIONAL_KEYS) {
      const field = def(key);
      // A default state is only honest if it says what llama.cpp does instead.
      expect(field.defaultNote ?? "").not.toBe("");
    }
  });

  test("every default is null, so nothing is sent until it is chosen", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      expect(cfg[key as keyof typeof cfg]).toBeNull();
    }
  });

  test("the default state prints the llama.cpp default, not a bare off", () => {
    const cfg = defaultConfig();
    expect(fieldDisplay(cfg, def("temp"))).toBe("default (0.8)");
    expect(fieldDisplay(cfg, def("jinja"))).toBe("default (on)");
    expect(fieldDisplay(cfg, def("threads"))).toBe("default (hardware threads)");
    expect(fieldDisplay(cfg, def("enableProps"))).toBe("default (off (GET only))");
    expect(fieldDisplay(cfg, def("gpuLayers"))).toBe("default (auto)");
    // The context group keeps plain numbers, and extra keeps its own wording.
    expect(fieldDisplay(cfg, def("ctxSize"))).toBe("0");
    expect(fieldDisplay({ ...cfg, extra: [] }, def("extra"))).toBe("(none)");
    expect(fieldDisplay({ ...cfg, extra: ["--flash-attn", "off"] }, def("extra"))).toBe("--flash-attn off");
  });

  test("configValue renders a raw value the way the editor does", () => {
    expect(configValue("temp", null)).toBe("default (0.8)");
    expect(configValue("temp", 0.35)).toBe("0.35");
    expect(configValue("jinja", true)).toBe("on");
    expect(configValue("nope", null)).toBe("--");
  });

  test("a numeric parameter turns on at its own value and drops past max", () => {
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      if (d.kind !== "int" && d.kind !== "float") continue;
      const on = nudgeField(defaultConfig(), d, 1);
      const onValue = on[key as keyof typeof on];
      expect(typeof onValue).toBe("number");
      expect(fieldDisplay(on, d)).toBe(fieldDisplay(on, d));
      expect(fieldDisplay(on, d)).not.toContain("default");
      // Stepping up from the maximum returns to the default state.
      const atMax = nudgeField({ ...on, [key]: d.max } as never, d, 1);
      expect(atMax[key as keyof typeof atMax]).toBeNull();
      expect(fieldDisplay(atMax, d)).toBe(`default (${d.defaultNote})`);
      // ...and the default state turns it back on at the same value.
      expect(nudgeField(atMax, d, 1)[key as keyof typeof on]).toBe(onValue);
    }
  });

  test("every numeric cycle step lands on a distinct grid value", () => {
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      if (d.kind !== "int" && d.kind !== "float") continue;
      const cfg = defaultConfig();
      const start = nudgeField(cfg, d, 1)[key as keyof typeof cfg] as number;
      const seen: (number | null)[] = [start];
      let cur = start;
      while (cur < d.max!) {
        cur = nudgeField({ ...cfg, [key]: cur } as never, d, 1)[key as keyof typeof cfg] as number;
        seen.push(cur);
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(Math.round((d.max! - start) / d.step!) + 1);
      // Walking down covers the same values in reverse.
      const down: number[] = [];
      let back: number = d.max!;
      while (back > start) {
        back = nudgeField({ ...cfg, [key]: back } as never, d, -1)[key as keyof typeof cfg] as number;
        down.push(back);
      }
      expect(down).toEqual(seen.slice(0, -1).reverse());
    }
  });

  test("text parameters cycle their documented values and come back to the default", () => {
    for (const key of ["gpuLayers", "thinking", "reasoning"]) {
      const d = def(key);
      const states = fieldStates(d);
      // The default state is part of the ring, so the flag is always droppable.
      expect(states[0]).toBeNull();
      expect(new Set(states).size).toBe(states.length);
      let cur = defaultConfig();
      const visited: (string | null)[] = [];
      for (let i = 0; i < states.length; i += 1) {
        cur = nudgeField(cur, d, 1);
        visited.push(cur[key as keyof typeof cur] as string | null);
      }
      // One pass visits every state once and lands back on the default state,
      // so the visited ring is the same cycle entered one step later.
      expect(new Set(visited).size).toBe(states.length);
      expect(visited).toEqual([...states.slice(1), states[0]]);
    }
    // `auto` is a real, explicit state only where llama.cpp spells it that way.
    expect(fieldStates(def("gpuLayers"))).toEqual([null, "auto", "0", "all"]);
    expect(fieldStates(def("reasoning"))).toEqual([null, "auto", "deepseek", "deepseek-legacy", "none"]);
    // Stepping left from the default state wraps to the end of the range.
    expect(nudgeField(defaultConfig(), def("thinking"), -1).thinking).toBe("none");
  });

  test("typed input turns a value off and back on", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      if (d.kind === "bool") {
        expect(applyFieldEdit(cfg, d, "on")[key as keyof typeof cfg]).toBe(true);
        expect(applyFieldEdit(cfg, d, "off")[key as keyof typeof cfg]).toBe(false);
        for (const word of ["default", "auto", "none", ""]) {
          expect(applyFieldEdit(cfg, d, word)[key as keyof typeof cfg]).toBeNull();
        }
        continue;
      }
      for (const word of ["default", "auto", "none", "off", "", "   "]) {
        expect(applyFieldEdit(cfg, d, word)[key as keyof typeof cfg]).toBeNull();
      }
      if (d.kind === "text") {
        // A text field takes what was typed, and `auto` is how you type the
        // default state back in.
        expect(applyFieldEdit({ ...cfg, [key]: null } as never, d, "max")[key as keyof typeof cfg]).toBe("max");
        expect(applyFieldEdit({ ...cfg, [key]: "max" } as never, d, "auto")[key as keyof typeof cfg]).toBeNull();
        continue;
      }
      const typed = d.kind === "int" ? "25" : "0.5";
      const parsed = d.kind === "int" ? 25 : 0.5;
      expect(applyFieldEdit({ ...cfg, [key]: null } as never, d, typed)[key as keyof typeof cfg]).toBe(
        parsed,
      );
      expect(applyFieldEdit({ ...cfg, [key]: null } as never, d, "junk")[key as keyof typeof cfg]).toBeNull();
      // Clamping still applies to typed values.
      expect(applyFieldEdit(cfg, d, "9999")[key as keyof typeof cfg]).toBe(d.max);
      expect(applyFieldEdit(cfg, d, "-5")[key as keyof typeof cfg]).toBe(d.min);
    }
  });

  test("the default state survives a preset round-trip", () => {
    const cfg = { ...defaultConfig(), temp: 0.4, topK: null, thinking: "none" };
    const back = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    expect(back.temp).toBe(0.4);
    expect(back.topK).toBeNull();
    expect(back.thinking).toBe("none");
    expect(fieldDisplay(back, def("topK"))).toBe("default (40)");
  });
});

describe("the parameter manual", () => {
  test("documents every optional parameter the editor exposes", () => {
    const documented = manualFieldKeys();
    const optional = CONFIG_FIELDS.filter((f) => f.optional).map((f) => f.key);
    for (const key of optional) expect(documented).toContain(key);
    // The manual never invents a field, and never points at a dropped one.
    for (const key of documented) expect(CONFIG_FIELDS.map((f) => f.key)).toContain(key);
  });

  test("every entry states llama.cpp's default and what it changes", () => {
    expect(MANUAL_ENTRY_COUNT).toBeGreaterThan(30);
    for (const group of MANUAL_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.flag.length).toBeGreaterThan(0);
        expect(entry.llamaDefault.length).toBeGreaterThan(0);
        expect(entry.effect.length).toBeGreaterThan(20);
      }
    }
  });

  test("the auto spellings are states the field can actually reach", () => {
    for (const field of CONFIG_FIELDS) {
      if (field.autoValue === undefined) continue;
      // An `auto` state is only declared where llama.cpp has one, and it has
      // to be a state the editor's cycle really visits.
      expect(fieldStates(field)).toContain(String(field.autoValue));
    }
  });

  test("the thinking layers are documented as two independent parameters", () => {
    const effort = manualEntryFor("thinking");
    const format = manualEntryFor("reasoning");
    expect(effort?.flag).toBe("reasoning_effort");
    expect(format?.flag).toBe("reasoning_format");
    expect(format?.effect).toContain("deepseek-legacy");
  });
});

describe("hub model entries", () => {
  test("empty dir shows notice + hf row", () => {
    const rows = selectableEntries(buildModelEntries([]));
    expect(rows.map((r) => r.kind)).toEqual(["hf"]);
    expect(entryLabel({ kind: "empty" })).toContain("no local models");
  });
  test("local models listed with sizes, then hf + refresh", () => {
    const rows = buildModelEntries([
      { name: "a.gguf", path: "/m/a.gguf", sizeMiB: 100, mtimeMs: 0 },
      { name: "b.gguf", path: "/m/b.gguf", sizeMiB: 200, mtimeMs: 0 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["local", "local", "hf", "refresh"]);
    expect(entryLabel(rows[0]!)).toContain("100 MiB");
  });
});

describe("splash frames", () => {
  test("logo reveals progressively then completes", () => {
    const early = splashFrame(0);
    const late = splashFrame(60_000);
    expect(early.logo.split("\n").length).toBeLessThan(late.logo.split("\n").length);
    expect(late.done).toBe(true);
    expect(late.status).toContain("loading lazyllama");
  });
  test("completed logo carries the animated glint highlight", () => {
    const early = splashFrame(0);
    const late = splashFrame(60_000);
    expect(early.styledLogo.chunks.some((chunk) => chunk.attributes === 1)).toBe(false);
    expect(late.styledLogo.chunks.some((chunk) => chunk.attributes === 1)).toBe(true);
  });
  test("block wordmark uses equal one-column rows", () => {
    const lines = logoLines();
    expect(LAZYLLAMA_LOGO).toContain("██╗");
    expect(lines.length).toBe(6);
    const widths = lines.map((line) => Array.from(line).length);
    expect(new Set(widths).size).toBe(1);
  });
  test("glint sweep traverses the full logo width", () => {
    const width = Math.max(...logoLines().map((line) => Array.from(line).length));
    expect(splashGlintSweep(0, width)).toBeLessThanOrEqual(0);
    expect(splashGlintSweep((width + 16) * 60 - 1, width)).toBeGreaterThanOrEqual(width);
  });
});
