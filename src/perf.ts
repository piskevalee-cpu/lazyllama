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
}

// Best-effort read of the slots endpoint (enabled by default on the
// server). Every field is optional; never throws.
export async function fetchServerStats(baseUrl: string): Promise<ServerStats> {
  if (!baseUrl) return {};
  try {
    const res = await fetch(`${baseUrl}/slots`);
    if (!res.ok) return {};
    const slots = (await res.json()) as Array<{
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
    return out;
  } catch {
    return {};
  }
}
