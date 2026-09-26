// Pure-logic tests: config args, ASCII helpers, perf formatting.
// Renderer behavior is covered separately in test/ui.test.ts.

import { describe, expect, test } from "bun:test";
import {
  CONFIG_FIELDS,
  CONFIG_GROUP_ORDER,
  CONFIG_GROUP_TITLES,
  abbreviateHome,
  applyFieldEdit,
  defaultConfig,
  fieldDisplay,
  modelDisplayName,
  modelId,
  modelSourceLabel,
  nudgeField,
  toServerArgs,
} from "../src/config.ts";
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
  test("hf model maps to -hf plus props/metrics", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "hf", repo: "ggml-org/Qwen3.5-0.8B-GGUF" };
    const args = toServerArgs(cfg);
    expect(args).toContain("-hf");
    expect(args).toContain("ggml-org/Qwen3.5-0.8B-GGUF");
    expect(args).toContain("--props");
    expect(args).toContain("--metrics");
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
  test("nulled sampling params drop their flags", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    cfg.temp = null;
    cfg.topP = null;
    cfg.topK = null;
    cfg.repeatPenalty = null;
    const args = toServerArgs(cfg);
    expect(args).not.toContain("--temp");
    expect(args).not.toContain("--top-p");
    expect(args).not.toContain("--top-k");
    expect(args).not.toContain("--repeat-penalty");
    expect(args).toContain("--jinja");
  });
  test("set sampling params keep their flags and order", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/models/q.gguf" };
    const args = toServerArgs(cfg);
    const order = ["--temp", "--top-p", "--top-k", "--repeat-penalty"];
    for (const flag of order) expect(args).toContain(flag);
    const at = order.map((flag) => args.indexOf(flag));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(args[args.indexOf("--temp") + 1]).toBe("0.7");
    expect(args[args.indexOf("--top-p") + 1]).toBe("0.9");
    expect(args[args.indexOf("--top-k") + 1]).toBe("40");
    expect(args[args.indexOf("--repeat-penalty") + 1]).toBe("1");
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
  test("nudge steps ints, toggles bools, cycles text options", () => {
    const cfg = defaultConfig();
    cfg.model = { kind: "local", path: "/m/q.gguf" };
    const ctx = CONFIG_FIELDS.find((f) => f.key === "ctxSize")!;
    expect(fieldDisplay(nudgeField(cfg, ctx, 1), ctx)).toBe("1024");
    const jinja = CONFIG_FIELDS.find((f) => f.key === "jinja")!;
    expect(fieldDisplay(nudgeField(cfg, jinja, 1), jinja)).toBe("off");
    const ngl = CONFIG_FIELDS.find((f) => f.key === "gpuLayers")!;
    expect(fieldDisplay(nudgeField(cfg, ngl, 1), ngl)).toBe("0");
    expect(fieldDisplay(nudgeField(nudgeField(cfg, ngl, 1), ngl, -1), ngl)).toBe("auto");
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

describe("optional sampling fields", () => {
  const OPTIONAL_KEYS = ["temp", "topP", "topK", "repeatPenalty"] as const;

  function def(key: string) {
    return CONFIG_FIELDS.find((f) => f.key === key)!;
  }

  test("only the sampling fields are nullable", () => {
    for (const key of OPTIONAL_KEYS) expect(def(key).optional).toBe(true);
    for (const field of CONFIG_FIELDS) {
      if (!OPTIONAL_KEYS.includes(field.key as (typeof OPTIONAL_KEYS)[number])) {
        expect(field.optional).toBeUndefined();
      }
    }
  });

  test("fieldDisplay renders off for null and the value otherwise", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      expect(fieldDisplay(cfg, d)).toBe(String(cfg[key]));
      expect(fieldDisplay({ ...cfg, [key]: null }, d)).toBe("off");
    }
    // a null non-optional field still reads as "not set"
    const extra = def("extra");
    expect(fieldDisplay({ ...cfg, extra: [] }, extra)).toBe("(none)");
    expect(fieldDisplay({ ...cfg, temp: 1.25 }, def("temp"))).toBe("1.25");
  });

  test("nudge turns a field off from max and back on from off", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      const max = d.max!;
      const off = nudgeField({ ...cfg, [key]: max }, d, 1);
      expect(off[key]).toBeNull();
      expect(fieldDisplay(off, d)).toBe("off");
      const on = nudgeField(off, d, 1);
      expect(on[key]).toBe(cfg[key]);
      expect(fieldDisplay(on, d)).toBe(String(cfg[key]));
      // off is also the top of the range when stepping down
      expect(nudgeField(off, d, -1)[key]).toBe(max);
    }
  });

  test("the cycle never skips a state", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      const step = d.step!;
      const start = cfg[key] as number;
      // walk up from the default to max: every step lands on a distinct grid value
      const seen: (number | null)[] = [start];
      let cur = start;
      while (cur < d.max!) {
        cur = nudgeField({ ...cfg, [key]: cur }, d, 1)[key] as number;
        seen.push(cur);
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(Math.round((d.max! - start) / step) + 1);
      // then off, then straight back on at the default: no dead zone
      const off = nudgeField({ ...cfg, [key]: cur }, d, 1);
      expect(off[key]).toBeNull();
      expect(nudgeField(off, d, 1)[key]).toBe(start);
      // walking down from max covers the same values in reverse
      const down: number[] = [];
      let back: number = d.max!;
      while (back > start) {
        back = nudgeField({ ...cfg, [key]: back }, d, -1)[key] as number;
        down.push(back);
      }
      expect(down).toEqual(seen.slice(0, -1).reverse());
    }
  });

  test("applyFieldEdit turns values off and back on", () => {
    const cfg = defaultConfig();
    for (const key of OPTIONAL_KEYS) {
      const d = def(key);
      for (const off of ["off", "OFF", "none", "", "   "]) {
        expect(applyFieldEdit(cfg, d, off)[key]).toBeNull();
      }
      const typed = d.kind === "int" ? "25" : "0.5";
      const parsed = d.kind === "int" ? 25 : 0.5;
      expect(applyFieldEdit({ ...cfg, [key]: null }, d, typed)[key]).toBe(parsed);
      expect(applyFieldEdit({ ...cfg, [key]: null }, d, "junk")[key]).toBeNull();
      // clamping still applies to typed values
      expect(applyFieldEdit(cfg, d, "9999")[key]).toBe(d.max);
      expect(applyFieldEdit(cfg, d, "-5")[key]).toBe(d.min);
    }
  });

  test("off survives a preset round-trip", () => {
    const cfg = { ...defaultConfig(), temp: null, topK: null };
    const back = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
    expect(back.temp).toBeNull();
    expect(back.topK).toBeNull();
    expect(fieldDisplay(back, def("temp"))).toBe("off");
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
