// Backend catalog and hardware survey: everything needed to answer "which
// llama.cpp build should this machine get?" without downloading anything.
//
// The catalog is data-driven (like CONFIG_FIELDS) so the installer's backend
// picker, the asset picker and the docs all read the same table. Every helper
// here is pure: it takes text or plain objects so tests use fixtures and never
// touch the network, the real GPU or /proc.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, freemem, platform, totalmem } from "node:os";

// llama.cpp publishes one prebuilt tarball per accelerator per arch in its
// bNNNN releases. Ids double as the receipt's `backend` value, so they name the
// exact asset slice rather than a family.
export type Backend =
  | "cpu"
  | "vulkan"
  | "cuda-12.8"
  | "cuda-13.4"
  | "rocm"
  | "sycl-fp16"
  | "sycl-fp32"
  | "openvino"
  | "metal"
  | "source";

export type Platform = "linux" | "macos" | "win";
export type CpuArch = "x64" | "arm64" | "s390x";

export function currentPlatform(nodePlatform: string = platform()): Platform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "win";
  return "linux";
}

export function currentArch(nodeArch: string = arch()): CpuArch {
  if (nodeArch === "arm64") return "arm64";
  if (nodeArch === "s390x") return "s390x";
  return "x64";
}

/** llama.cpp release assets are `<dir>bin-ubuntu-<flavour>-<arch>.tar.gz`. */
export const ARCH_TOKEN: Record<CpuArch, string> = {
  x64: "x64",
  arm64: "arm64",
  s390x: "s390x",
};

/** Asset names call the Linux builds "ubuntu", whatever we call the platform. */
export const PLATFORM_TOKEN: Record<Platform, string> = {
  linux: "ubuntu",
  macos: "macos",
  win: "win",
};

/** Tokens that mark a build as accelerated: the CPU pick must never match one. */
const ACCEL_TOKENS = [
  "cuda",
  "cudart",
  "rocm",
  "sycl",
  "openvino",
  "vulkan",
  "metal",
  "android",
  "opencl",
  "win",
  "snapdragon",
];

export interface BackendDef {
  id: Backend;
  /** Menu label, e.g. "CUDA 12.8". */
  label: string;
  /** One muted line under the label. */
  blurb: string;
  platforms: Platform[];
  archs: CpuArch[];
  /** All of these must appear (case-insensitively) in the asset file name. */
  assetTokens: string[];
  /** Approximate download size, used for the disk pre-flight and expectations. */
  approxMiB: number;
  /** Substrings `--list-devices` must report for the build to be considered good. */
  deviceTokens?: string[];
  /** Minimum NVIDIA driver major, when the bundle pins a CUDA runtime. */
  minNvidiaDriver?: number;
  /** Try these backends when this one cannot be downloaded or verified. */
  fallback: Backend[];
}

const LINUX_X64: CpuArch[] = ["x64", "arm64"];

export const BACKEND_CATALOG: BackendDef[] = [
  {
    id: "cpu",
    label: "CPU",
    blurb: "portable baseline, works everywhere",
    platforms: ["linux", "macos", "win"],
    archs: ["x64", "arm64", "s390x"],
    assetTokens: [],
    approxMiB: 17,
    fallback: ["source"],
  },
  {
    id: "vulkan",
    label: "Vulkan",
    blurb: "one path for AMD, Intel and NVIDIA GPUs",
    platforms: ["linux"],
    archs: LINUX_X64,
    assetTokens: ["vulkan"],
    approxMiB: 30,
    deviceTokens: ["vulkan"],
    fallback: ["cpu", "source"],
  },
  {
    id: "cuda-12.8",
    label: "CUDA 12.8",
    blurb: "NVIDIA, CUDA runtime bundled",
    platforms: ["linux"],
    archs: LINUX_X64,
    // The cudart-* bundle ships the runtime; the plain cuda-* one does not.
    assetTokens: ["cudart", "cuda-12.8"],
    approxMiB: 567,
    deviceTokens: ["cuda"],
    minNvidiaDriver: 565,
    fallback: ["cuda-13.4", "vulkan", "cpu", "source"],
  },
  {
    id: "cuda-13.4",
    label: "CUDA 13.4",
    blurb: "NVIDIA, newer runtime, needs a recent driver",
    platforms: ["linux"],
    archs: LINUX_X64,
    assetTokens: ["cudart", "cuda-13.4"],
    approxMiB: 590,
    deviceTokens: ["cuda"],
    minNvidiaDriver: 580,
    fallback: ["cuda-12.8", "vulkan", "cpu", "source"],
  },
  {
    id: "rocm",
    label: "ROCm 10.0",
    blurb: "AMD, best on RDNA 3 and newer",
    platforms: ["linux"],
    archs: ["x64"],
    assetTokens: ["rocm"],
    approxMiB: 229,
    deviceTokens: ["rocm", "hip"],
    fallback: ["vulkan", "cpu", "source"],
  },
  {
    id: "sycl-fp16",
    label: "SYCL (fp16)",
    blurb: "Intel oneAPI, fast on Arc and Core Ultra",
    platforms: ["linux"],
    archs: ["x64"],
    assetTokens: ["sycl", "fp16"],
    approxMiB: 53,
    deviceTokens: ["sycl", "level_zero", "level zero"],
    fallback: ["sycl-fp32", "vulkan", "cpu", "source"],
  },
  {
    id: "sycl-fp32",
    label: "SYCL (fp32)",
    blurb: "Intel oneAPI for GPUs without fp16",
    platforms: ["linux"],
    archs: ["x64"],
    assetTokens: ["sycl", "fp32"],
    approxMiB: 53,
    deviceTokens: ["sycl", "level_zero", "level zero"],
    fallback: ["sycl-fp16", "vulkan", "cpu", "source"],
  },
  {
    id: "openvino",
    label: "OpenVINO",
    blurb: "Intel NPU and Core Ultra integrated GPUs",
    platforms: ["linux"],
    archs: ["x64"],
    assetTokens: ["openvino"],
    approxMiB: 40,
    deviceTokens: ["openvino"],
    fallback: ["sycl-fp16", "vulkan", "cpu", "source"],
  },
  {
    id: "metal",
    label: "Metal",
    blurb: "Apple Silicon, included in the macOS build",
    platforms: ["macos"],
    archs: ["x64", "arm64"],
    assetTokens: ["macos"],
    approxMiB: 11,
    deviceTokens: ["metal"],
    fallback: ["source"],
  },
  {
    id: "source",
    label: "Build from source",
    blurb: "cmake + make against llama.cpp, slow but exact",
    platforms: ["linux", "macos", "win"],
    archs: ["x64", "arm64", "s390x"],
    assetTokens: [],
    approxMiB: 0,
    fallback: [],
  },
];

const BY_ID = new Map(BACKEND_CATALOG.map((def) => [def.id, def]));

export function backendDef(id: Backend): BackendDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown backend: ${id}`);
  return def;
}

export function backendLabel(id: Backend): string {
  return BY_ID.get(id)?.label ?? id;
}

// -- hardware survey ------------------------------------------------------

export interface GpuInfo {
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
  name: string;
}

export interface Hardware {
  prettyOs: string;
  arch: CpuArch;
  gpus: GpuInfo[];
  nvidiaDriverMajor?: number;
  hasVulkanLoader: boolean;
  vulkanDevices: string[];
  cpuFlags: string[];
  cpuModel: string;
  cores: number;
  totalMemBytes: number;
  usedMemBytes: number;
  hasCmake: boolean;
}

export function parseOsRelease(text: string): string {
  const pretty = text.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
  if (pretty) return pretty.slice("PRETTY_NAME=".length).replace(/^"|"$/g, "");
  const id = text.split("\n").find((l) => l.startsWith("ID="));
  return id ? id.slice(3).replace(/^"|"$/g, "") : platform();
}

export function parseLspci(text: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of text.split("\n")) {
    if (!/vga|3d controller|display controller/i.test(line)) continue;
    const idMatch = line.match(/\[([0-9a-fA-F]{4}):[0-9a-fA-F]{4}\]/);
    const vendorId = idMatch?.[1]?.toLowerCase();
    const vendor =
      vendorId === "10de" ? "nvidia" : vendorId === "1002" ? "amd" : vendorId === "8086" ? "intel" : "other";
    const name = line
      .split(": ")
      .slice(1)
      .join(": ")
      .replace(/\s*\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\].*$/, "")
      .trim();
    out.push({ vendor, name });
  }
  return out;
}

export function parseNvidiaDriverVersion(text: string): number | undefined {
  const m = text.trim().match(/^(\d+)\./);
  return m?.[1] ? Number(m[1]) : undefined;
}

export function parseVulkanDevices(summary: string): string[] {
  const names: string[] = [];
  for (const line of summary.split("\n")) {
    const m = line.match(/deviceName\s*=\s*(.+)/);
    if (m?.[1]) names.push(m[1].trim());
  }
  return names;
}

export function parseCpuModel(cpuinfo: string): string {
  const line = cpuinfo.split("\n").find((l) => l.startsWith("model name"));
  return line ? (line.split(":")[1] ?? "").trim() : "";
}

export function parseCpuFlags(cpuinfo: string): string[] {
  const line = cpuinfo.split("\n").find((l) => l.startsWith("flags"));
  return line ? (line.split(":")[1] ?? "").trim().split(/\s+/) : [];
}

function commandOut(cmd: string, args: string[], timeoutMs = 15000): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
  } catch {
    return undefined;
  }
}

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function detectHardware(): Hardware {
  const archName = currentArch();
  const hasCmake = commandExists("cmake");
  let prettyOs: string = platform();
  let cpuFlags: string[] = [];
  let cpuModel = "";
  let cores = cpus().length;
  try {
    prettyOs = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    // non-Linux (macOS/Windows): keep the platform id
  }
  if (platform() === "darwin") {
    cpuModel = commandOut("sysctl", ["-n", "machdep.cpu.brand_string"]) ?? (archName === "arm64" ? "Apple Silicon" : "");
    const arm = archName === "arm64";
    return {
      prettyOs: "macOS",
      arch: archName,
      gpus: arm ? [{ vendor: "apple", name: "Apple Silicon (Metal)" }] : [],
      hasVulkanLoader: false,
      vulkanDevices: [],
      cpuFlags: [],
      cpuModel,
      cores,
      totalMemBytes: totalmem(),
      usedMemBytes: freemem(),
      hasCmake,
    };
  }
  const lspci = commandOut("lspci", ["-nn"]);
  const gpus = lspci ? parseLspci(lspci) : [];
  const driverOut = commandOut("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]);
  const nvidiaDriverMajor = driverOut ? parseNvidiaDriverVersion(driverOut) : undefined;
  const ldconfig = commandOut("ldconfig", ["-p"]);
  const hasVulkanLoader = ldconfig !== undefined && ldconfig.includes("libvulkan.so");
  // `vulkaninfo --version` is not a valid flag on all builds (exits 1); go
  // straight for --summary and treat failure as "no devices enumerated".
  const vulkanDevices = hasVulkanLoader ? parseVulkanDevices(commandOut("vulkaninfo", ["--summary"]) ?? "") : [];
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    cpuFlags = parseCpuFlags(cpuinfo);
    cpuModel = parseCpuModel(cpuinfo);
    const count = Number(cpuinfo.split("\n").filter((l) => l.startsWith("processor")).length);
    if (Number.isFinite(count) && count > 0) cores = count;
  } catch {
    // ignore: leave the os.cpus() fallback
  }
  return {
    prettyOs,
    arch: archName,
    gpus,
    nvidiaDriverMajor,
    hasVulkanLoader,
    vulkanDevices,
    cpuFlags,
    cpuModel,
    cores,
    totalMemBytes: totalmem(),
    usedMemBytes: freemem(),
    hasCmake,
  };
}

// -- availability ---------------------------------------------------------

export interface BackendOption {
  def: BackendDef;
  /** Usable on this machine: the asset exists and its requirements are met. */
  available: boolean;
  /** Why it is available, and why it was recommended when it was. */
  reasons: string[];
  /** Requirements this machine does not meet. */
  blockers: string[];
  recommended: boolean;
  /** Ordered alternatives to try when this one fails. */
  fallback: Backend[];
}

export interface BackendProposal {
  backend: Backend;
  reasons: string[];
  warnings: string[];
}

/** SIMD extensions worth calling out, best first. */
const SIMD_TOKENS = ["avx512f", "avx2", "vnni", "amx_int8", "neon"];

/** The interesting CPU flags as one phrase, or a plain admission of none. */
export function simdSummary(hw: Hardware): string {
  return SIMD_TOKENS.filter((flag) => hw.cpuFlags.includes(flag)).join(", ") || "no known SIMD";
}

function simdNote(hw: Hardware): string {
  const hit = SIMD_TOKENS.filter((f) => hw.cpuFlags.includes(f));
  return hit.length > 0 ? hit.join(", ") : "no known SIMD flags";
}

function gpuNames(hw: Hardware): string {
  return hw.gpus.map((g) => g.name).join("; ");
}

/**
 * Which CUDA bundle a given driver can load. CUDA 13.x needs a newer driver
 * than 12.8, so the driver major picks the slice instead of the newest tag.
 */
export function cudaBackendForDriver(driverMajor: number | undefined): Backend {
  if (driverMajor !== undefined && driverMajor >= (backendDef("cuda-13.4").minNvidiaDriver ?? 580)) return "cuda-13.4";
  return "cuda-12.8";
}

/**
 * The recommended backend, in priority order: NVIDIA with a driver new enough
 * for the newest CUDA bundle, then any Vulkan-capable GPU, then Intel's SYCL,
 * then Metal on Apple Silicon, then CPU.
 */
export function proposeBackend(hw: Hardware, plat: Platform = currentPlatform()): BackendProposal {
  const warnings: string[] = [];
  const hasNvidia = hw.gpus.some((g) => g.vendor === "nvidia");
  if (plat === "macos") {
    if (hw.gpus.some((g) => g.vendor === "apple") || hw.arch === "arm64") {
      return { backend: "metal", reasons: ["Apple Silicon: Metal ships in the macOS build"], warnings };
    }
    return { backend: "cpu", reasons: ["no Apple GPU detected"], warnings };
  }
  if (hasNvidia) {
    if (hw.nvidiaDriverMajor === undefined) {
      warnings.push("NVIDIA GPU present but nvidia-smi is unusable; skipping CUDA");
    } else {
      const pick = cudaBackendForDriver(hw.nvidiaDriverMajor);
      const def = backendDef(pick);
      if (hw.nvidiaDriverMajor >= (def.minNvidiaDriver ?? 0)) {
        return {
          backend: pick,
          reasons: [`NVIDIA GPU with driver ${hw.nvidiaDriverMajor} (${def.label} needs >= ${def.minNvidiaDriver})`],
          warnings,
        };
      }
      warnings.push(
        `NVIDIA driver ${hw.nvidiaDriverMajor} predates ${def.label} (need >= ${def.minNvidiaDriver}); skipping CUDA`,
      );
    }
  }
  const names = gpuNames(hw);
  if (hw.vulkanDevices.length > 0) {
    return {
      backend: "vulkan",
      reasons: [`Vulkan device(s): ${hw.vulkanDevices.join("; ")}${names ? ` (pci: ${names})` : ""}`],
      warnings,
    };
  }
  if (hw.hasVulkanLoader && hw.gpus.some((g) => g.vendor === "amd" || g.vendor === "intel")) {
    return {
      backend: "vulkan",
      reasons: [`${names} with Vulkan loader present (devices not enumerated)`],
      warnings,
    };
  }
  if (hw.gpus.some((g) => g.vendor === "intel")) {
    return { backend: "sycl-fp16", reasons: [`${names} without a usable Vulkan path, trying Intel SYCL`], warnings };
  }
  return {
    backend: "cpu",
    reasons: [hw.gpus.length > 0 ? `no accelerated path for: ${names}` : "no GPU detected", `CPU fallback (${simdNote(hw)})`],
    warnings,
  };
}

function assess(hw: Hardware, def: BackendDef, plat: Platform): BackendOption {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (!def.platforms.includes(plat)) {
    blockers.push(`no ${def.label} build for ${plat}`);
  }
  if (!def.archs.includes(hw.arch)) {
    blockers.push(`no ${def.label} build for ${hw.arch}`);
  }
  const hasNvidia = hw.gpus.some((g) => g.vendor === "nvidia");
  const hasAmd = hw.gpus.some((g) => g.vendor === "amd");
  const hasIntel = hw.gpus.some((g) => g.vendor === "intel");
  const names = gpuNames(hw);
  switch (def.id) {
    case "cpu":
      reasons.push(`${hw.cores} threads, ${simdNote(hw)}`);
      break;
    case "vulkan":
      if (!hw.hasVulkanLoader) blockers.push("no Vulkan loader (libvulkan.so)");
      else if (hw.vulkanDevices.length === 0) blockers.push("Vulkan loader present but no devices enumerated");
      else reasons.push(`devices: ${hw.vulkanDevices.join("; ")}`);
      break;
    case "cuda-12.8":
    case "cuda-13.4":
      if (!hasNvidia) blockers.push("no NVIDIA GPU detected");
      else if (hw.nvidiaDriverMajor === undefined) blockers.push("nvidia-smi is unusable");
      else if (hw.nvidiaDriverMajor < (def.minNvidiaDriver ?? 0)) {
        blockers.push(`driver ${hw.nvidiaDriverMajor} < ${def.minNvidiaDriver}`);
      } else reasons.push(`driver ${hw.nvidiaDriverMajor} >= ${def.minNvidiaDriver}`);
      break;
    case "rocm":
      if (!hasAmd) blockers.push("no AMD GPU detected");
      break;
    case "sycl-fp16":
    case "sycl-fp32":
    case "openvino":
      if (!hasIntel) blockers.push("no Intel GPU detected");
      break;
    case "metal":
      if (hw.gpus.length === 0) blockers.push("no Apple GPU detected");
      break;
    case "source":
      if (!hw.hasCmake) blockers.push("cmake not installed");
      else reasons.push("cmake available");
      break;
  }
  // Name the GPU only once every requirement is met: a blocked row should show
  // what is missing, not the part that happens to work.
  if (blockers.length === 0 && names.length > 0 && def.id !== "vulkan") reasons.push(names);
  return { def, available: blockers.length === 0, reasons, blockers, recommended: false, fallback: def.fallback };
}

/** Every catalog entry for this platform, annotated and sorted best-first. */
export function assessBackends(hw: Hardware, plat: Platform = currentPlatform()): BackendOption[] {
  const proposal = proposeBackend(hw, plat);
  const applicable = BACKEND_CATALOG.filter((def) => def.platforms.includes(plat) && def.archs.includes(hw.arch));
  const options = applicable.map((def) => assess(hw, def, plat));
  const recommended = options.find((option) => option.def.id === proposal.backend && option.available);
  if (recommended) {
    // The proposal already carries the "why" for the pick; restating the
    // per-backend reason here just duplicates it.
    recommended.recommended = true;
    recommended.reasons = proposal.reasons;
  }
  // Unavailable entries sink; source stays last because it is the slow path.
  return options.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.available !== b.available) return a.available ? -1 : 1;
    if ((a.def.id === "source") !== (b.def.id === "source")) return a.def.id === "source" ? 1 : -1;
    return 0;
  });
}

export function describeHardware(hw: Hardware): string {
  const lines = [`OS: ${hw.prettyOs} (${hw.arch})`];
  if (hw.cpuModel) lines.push(`CPU: ${hw.cpuModel} (${hw.cores} threads)`);
  lines.push(hw.gpus.length > 0 ? `GPU: ${hw.gpus.map((g) => `[${g.vendor}] ${g.name}`).join(" | ")}` : "GPU: none detected");
  if (hw.nvidiaDriverMajor !== undefined) lines.push(`NVIDIA driver: ${hw.nvidiaDriverMajor}`);
  lines.push(`Vulkan loader: ${hw.hasVulkanLoader ? `yes (${hw.vulkanDevices.length} device(s))` : "no"}`);
  lines.push(`RAM: ${formatGiB(hw.usedMemBytes)} / ${formatGiB(hw.totalMemBytes)}`);
  return lines.join("\n");
}

export function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  return `${(bytes / 1073741824).toFixed(1)} GiB`;
}

// -- release asset picking ------------------------------------------------

export function isBinaryTag(tag: string): boolean {
  return /^b\d+$/.test(tag);
}

export function latestBinaryTag(tags: string[]): string | undefined {
  return tags.find((t) => isBinaryTag(t));
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface AssetTarget {
  platform: Platform;
  arch: CpuArch;
}

/**
 * Resolve the prebuilt asset for a backend. Matching is token-based rather
 * than name-exact so upstream renames do not silently break us, and the arch
 * token comes from the caller so arm64 machines resolve their own slice.
 */
export function pickAsset(
  assets: ReleaseAsset[],
  backend: Backend,
  target: AssetTarget = { platform: currentPlatform(), arch: currentArch() },
): ReleaseAsset | undefined {
  const def = backendDef(backend);
  if (backend === "source") return undefined;
  if (target.platform === "win") return undefined; // WSL or a manual install for now
  const lower = (s: string) => s.toLowerCase();
  const archToken = ARCH_TOKEN[target.arch];
  const tokens = [...def.assetTokens, archToken, PLATFORM_TOKEN[target.platform]];
  const matched = assets.find((asset) => {
    const name = lower(asset.name);
    if (!name.endsWith(".tar.gz")) return false;
    if (def.id === "cpu" && ACCEL_TOKENS.some((token) => name.includes(token))) return false;
    return tokens.every((token) => name.includes(token));
  });
  if (!matched) return undefined;
  // macOS ships one build with Metal compiled in, so both ids resolve it.
  return matched;
}

/** Ordered attempts: the chosen backend, then its fallbacks, de-duplicated. */
export function fallbackChain(backend: Backend): Backend[] {
  const out: Backend[] = [];
  const push = (id: Backend): void => {
    if (!out.includes(id)) out.push(id);
  };
  push(backend);
  for (const id of backendDef(backend).fallback) push(id);
  return out;
}

/** True when `--list-devices` output proves the build can see its device. */
export function deviceVisible(backend: Backend, output: string): boolean {
  const tokens = backendDef(backend).deviceTokens;
  if (!tokens || tokens.length === 0) return true;
  const lower = output.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}
