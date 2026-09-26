// System + server performance sampling. The side panel renders these values,
// so this module only samples and shapes them.

import { cpus, freemem, loadavg, totalmem } from "node:os";

export interface SystemSample {
  cpuPct: number; // 0..1 across all cores
  perCorePct: number[]; // 0..1 each
  memUsedMiB: number;
  memTotalMiB: number;
  load1: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

let prev: CpuTimes[] | null = null;

function snapshot(): CpuTimes[] {
  return cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

function frac(cur: CpuTimes, old: CpuTimes | undefined): number {
  if (!old) return 0;
  const dTotal = cur.total - old.total;
  const dIdle = cur.idle - old.idle;
  if (dTotal <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - dIdle / dTotal));
}

export function sampleSystem(): SystemSample {
  const cur = snapshot();
  const perCorePct = cur.map((c, i) => frac(c, prev?.[i]));
  const cpuPct = perCorePct.length > 0 ? perCorePct.reduce((a, b) => a + b, 0) / perCorePct.length : 0;
  prev = cur;
  const total = totalmem();
  const free = freemem();
  return {
    cpuPct,
    perCorePct,
    memUsedMiB: Math.round((total - free) / 1048576),
    memTotalMiB: Math.round(total / 1048576),
    load1: loadavg()[0] ?? 0,
  };
}

export interface ServerStats {
  tokPerSec?: number;
  promptTokens?: number;
  activeSlots?: number;
  /** Live KV footprint of the watched slot: prompt tokens plus generated. */
  slotContext?: SlotContext;
}

export interface SlotContext {
  used: number;
  total?: number;
  processing: boolean;
}

// Read one slot's live context. Field names differ between llama-server builds,
// so every candidate is optional and the caller falls back to turn timings.
// Pure so the parsing stays unit-testable.
export function readSlotContext(payload: unknown, slotId = 0): SlotContext | undefined {
  if (!Array.isArray(payload)) return undefined;
  const slot = payload[slotId];
  if (slot === null || typeof slot !== "object") return undefined;
  const rec = slot as Record<string, unknown>;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "number") return value;
    }
    return undefined;
  };
  // `next_token` is an object in newer builds and a one-element array in older
  // ones, so both shapes are read before falling back to the flat field names.
  const nextToken = rec["next_token"];
  const nextCandidates: unknown[] = Array.isArray(nextToken)
    ? nextToken
    : typeof nextToken === "object" && nextToken !== null
      ? [nextToken]
      : [];
  const generated =
    nextCandidates
      .map((entry) => (entry as Record<string, unknown>)["n_decoded"])
      .find((value): value is number => typeof value === "number") ??
    number("n_decoded", "tokens_predicted");
  const promptTokens =
    number("n_prompt_tokens") ??
    (() => {
      const processed = number("n_prompt_tokens_processed") ?? 0;
      const cache = number("n_prompt_tokens_cache") ?? 0;
      return processed + cache > 0 ? processed + cache : undefined;
    })();
  const total = number("n_ctx");
  if (promptTokens === undefined && total === undefined) return undefined;
  const used = (promptTokens ?? 0) + (generated ?? 0);
  return {
    used,
    total: total !== undefined && total > 0 ? total : undefined,
    processing: rec["is_processing"] === true,
  };
}

// Best-effort read of the slots endpoint (enabled by default on the
// server). Every field is optional; never throws.
export async function fetchServerStats(baseUrl: string): Promise<ServerStats> {
  if (!baseUrl) return {};
  try {
    const res = await fetch(`${baseUrl}/slots`);
    if (!res.ok) return {};
    const payload = (await res.json()) as unknown;
    const slots = payload as Array<{
      n_tokens_predicted?: number;
      t_tokens_generation_ms?: number;
      is_processing?: boolean;
    }>;
    if (!Array.isArray(slots)) return {};
    let tokens = 0;
    let ms = 0;
    let active = 0;
    for (const s of slots) {
      if (typeof s.n_tokens_predicted === "number") tokens += s.n_tokens_predicted;
      if (typeof s.t_tokens_generation_ms === "number") ms += s.t_tokens_generation_ms;
      if (s.is_processing === true) active += 1;
    }
    const out: ServerStats = { activeSlots: active };
    if (ms > 0) out.tokPerSec = (tokens / ms) * 1000;
    if (tokens > 0) out.promptTokens = tokens;
    out.slotContext = readSlotContext(payload);
    return out;
  } catch {
    return {};
  }
}
