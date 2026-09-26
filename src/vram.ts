// GPU memory sampling for the side panel and the installer's hardware survey.
//
// VRAM is the number that decides whether a model fits, so it is worth showing
// on a machine that has a GPU, and worth staying quiet on one that does not.
//
// Every vendor exposes it differently, and all of them are optional:
//   NVIDIA   nvidia-smi --query-gpu=name,memory.total,memory.used
//   AMD/Intel  /sys/class/drm/card*/device/mem_info_vram_{total,used}
//   ROCm     rocm-smi --showmeminfo vram
//   Apple    unified memory: shared with the system, no dedicated pool
// The parsers take text so the tests need no GPU, and the detector picks the
// first source that answers and then keeps using it, because each probe costs a
// process spawn and this runs on the panel's one-second timer.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";
import { join } from "node:path";
import { parseLspci } from "./backends.js";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

export interface GpuMemory {
  vendor: GpuVendor;
  name: string;
  totalBytes: number;
  /** Undefined when the source cannot report a live counter. */
  usedBytes?: number;
  /**
   * True when the GPU has no dedicated pool and shares system memory: Apple
   * Silicon, and integrated Intel/AMD graphics. There is nothing to meter, and
   * claiming a number here would be a lie.
   */
  shared: boolean;
}

function run(cmd: string, args: string[], timeoutMs = 4000): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    });
  } catch {
    return undefined;
  }
}

/** PCI vendor id as sysfs spells it, to the vendor the panel shows. */
export function vendorFromPciId(raw: string): GpuVendor {
  // sysfs writes "0x1002\n"; without the trim every card reads as "other".
  const pci = raw.trim().toLowerCase().replace(/^0x/, "");
  if (pci === "10de") return "nvidia";
  if (pci === "1002") return "amd";
  if (pci === "8086") return "intel";
  return "other";
}

// -- NVIDIA ---------------------------------------------------------------

/**
 * `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits`
 * prints one row per GPU: "NVIDIA GeForce RTX 4070, 12282, 812".
 */
export function parseNvidiaSmi(text: string): GpuMemory[] {
  const out: GpuMemory[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 2) continue;
    const [name, totalRaw, usedRaw] = parts;
    const total = Number(totalRaw);
    if (name === undefined || name.length === 0 || !Number.isFinite(total) || total <= 0) continue;
    const used = Number(usedRaw);
    out.push({
      vendor: "nvidia",
      name,
      totalBytes: total * 1024 * 1024,
      usedBytes: Number.isFinite(used) && used >= 0 ? used * 1024 * 1024 : undefined,
      shared: false,
    });
  }
  return out;
}

// -- sysfs (AMD and Intel discrete) ---------------------------------------

export interface DrmCard {
  /** Absolute sysfs device path, e.g. /sys/class/drm/card1/device. */
  device: string;
  vendor: GpuVendor;
  name: string;
}

/** Enumerate DRM cards that expose dedicated memory counters. */
export function readDrmCards(sysClassDrm = "/sys/class/drm", lspci?: string): DrmCard[] {
  let entries: string[];
  try {
    entries = readdirSync(sysClassDrm);
  } catch {
    return [];
  }
  const names = lspci === undefined ? undefined : parseLspci(lspci).map((gpu) => gpu.name);
  const cards: DrmCard[] = [];
  for (const entry of entries.filter((name) => /^card\d+$/.test(name))) {
    const device = join(sysClassDrm, entry, "device");
    const vendorFile = join(device, "vendor");
    if (!existsSync(vendorFile)) continue;
    const vendor = vendorFromPciId(readText(vendorFile) ?? "");
    const name =
      names?.find((candidate) => candidate.length > 0) ??
      (vendor === "amd" ? "AMD GPU" : vendor === "intel" ? "Intel GPU" : "GPU");
    cards.push({ device, vendor, name });
    // Names come from lspci in PCI order, so only the first card may claim one.
    if (names?.length) names.shift();
  }
  return cards;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read one card's dedicated memory. amdgpu and i915 publish hex byte counters
 * under mem_info_vram_{total,used}; a card without them has no dedicated pool,
 * which is how integrated graphics is recognised.
 */
export function readDrmMemory(card: DrmCard): GpuMemory | undefined {
  const totalRaw = readText(join(card.device, "mem_info_vram_total"));
  if (totalRaw === undefined) return undefined;
  const total = Number.parseInt(totalRaw.trim(), 16);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const usedRaw = readText(join(card.device, "mem_info_vram_used"));
  const used = usedRaw === undefined ? undefined : Number.parseInt(usedRaw.trim(), 16);
  return {
    vendor: card.vendor,
    name: card.name,
    totalBytes: total,
    usedBytes: used !== undefined && Number.isFinite(used) && used >= 0 ? used : undefined,
    shared: false,
  };
}

// -- ROCm -----------------------------------------------------------------

/**
 * `rocm-smi --showmeminfo vram --csv` prints rows such as
 * "GPU[0] : VRAM Total Memory (B) : 25753026560" and a "GPU[0] : Card series" row.
 */
export function parseRocmSmi(text: string): GpuMemory[] {
  const byDevice = new Map<number, GpuMemory>();
  for (const line of text.split("\n")) {
    const device = line.match(/GPU\[(\d+)\]/);
    if (!device) continue;
    const index = Number(device[1]);
    const current = byDevice.get(index) ?? {
      vendor: "amd" as GpuVendor,
      name: `AMD GPU ${index}`,
      totalBytes: 0,
      shared: false,
    };
    // "Card series" is the friendly name ("Radeon RX 7900 XTX"); "Card model" is
    // a PCI id and must never overwrite it, only stand in when it is missing.
    const series = line.match(/Card series\s*:\s*(.+)/);
    if (series?.[1]) current.name = series[1].trim();
    const model = line.match(/Card model\s*:\s*(.+)/);
    if (model?.[1] && current.name.startsWith("AMD GPU")) current.name = model[1].trim();
    const total = line.match(/VRAM Total Memory \(B\)\s*:\s*(\d+)/);
    if (total?.[1]) current.totalBytes = Number(total[1]);
    const used = line.match(/VRAM Total Used Memory \(B\)\s*:\s*(\d+)/);
    if (used?.[1]) current.usedBytes = Number(used[1]);
    byDevice.set(index, current);
  }
  return [...byDevice.values()].filter((entry) => entry.totalBytes > 0);
}

// -- detection ------------------------------------------------------------

type Source = () => GpuMemory[] | undefined;

let source: Source | undefined;
let cached: GpuMemory[] = [];

/** Drop the cached probe. Tests and a changed driver both need this. */
export function resetGpuMemoryCache(): void {
  source = undefined;
  cached = [];
}

function detectNvidia(): GpuMemory[] | undefined {
  const text = run("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.used",
    "--format=csv,noheader,nounits",
  ]);
  if (text === undefined) return undefined;
  const devices = parseNvidiaSmi(text);
  return devices.length > 0 ? devices : undefined;
}

function detectDrm(): GpuMemory[] | undefined {
  const lspci = run("lspci", ["-nn"]);
  const devices = readDrmCards("/sys/class/drm", lspci)
    .map((card) => readDrmMemory(card))
    .filter((entry): entry is GpuMemory => entry !== undefined);
  return devices.length > 0 ? devices : undefined;
}

function detectRocm(): GpuMemory[] | undefined {
  const text = run("rocm-smi", ["--showmeminfo", "vram", "--csv"]);
  if (text === undefined) return undefined;
  const devices = parseRocmSmi(text);
  return devices.length > 0 ? devices : undefined;
}

/**
 * Apple Silicon has no dedicated pool: Metal allocates from unified memory, so
 * the honest answer is the system total marked as shared rather than a VRAM
 * number that means nothing.
 */
function detectApple(): GpuMemory[] | undefined {
  if (platform() !== "darwin") return undefined;
  return [
    {
      vendor: "apple",
      name: "Apple Silicon (Metal)",
      totalBytes: totalmem(),
      // How much of unified memory the GPU holds is not exposed without a
      // driver call, so leave the counter unknown instead of guessing.
      usedBytes: undefined,
      shared: true,
    },
  ];
}

const SOURCES: Array<{ probe: Source; cuda: boolean }> = [
  { probe: detectNvidia, cuda: false },
  { probe: detectDrm, cuda: false },
  { probe: detectRocm, cuda: false },
  { probe: detectApple, cuda: false },
];

/**
 * Dedicated GPU memory for every device on the machine, or an empty list. The
 * first source that answers is kept for the rest of the session: probing
 * nvidia-smi, lspci and rocm-smi on every one-second panel tick would cost more
 * than the numbers are worth.
 */
export function sampleGpuMemory(): GpuMemory[] {
  if (source === undefined) {
    cached = [];
    for (const candidate of SOURCES) {
      const found = candidate.probe();
      if (found !== undefined && found.length > 0) {
        source = candidate.probe;
        cached = found;
        break;
      }
    }
    if (source === undefined) source = () => undefined;
  }
  const refreshed = source();
  if (refreshed !== undefined) cached = refreshed;
  return cached;
}

/** True when the machine has no dedicated GPU memory to show. */
export function hasNoGpuMemory(): boolean {
  return sampleGpuMemory().length === 0;
}

/**
 * Shared-memory machines still have a number worth showing: how much of the
 * system pool is in use is a proxy for how much the GPU can still get.
 */
export function sharedMemoryFraction(): number | undefined {
  const total = totalmem();
  if (total <= 0) return undefined;
  return Math.min(1, Math.max(0, 1 - freemem() / total));
}
