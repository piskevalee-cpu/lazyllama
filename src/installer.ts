// `bun run install:server` — zero-setup llama-server provisioning.
//
// Strategy (in order):
//   1. Detect backend: CUDA driver -> cuda, Vulkan loader -> vulkan, else cpu.
//   2. Download the matching prebuilt tarball from the latest bNNNN
//      llama.cpp release into the XDG data dir and verify `--version`.
//   3. Fallback: cmake build from ./llama.cpp (CPU, or Vulkan if glslc exists).
//
// LazyLlama itself never compiles: this script is explicit-only.
// Pure helpers (pickAsset, latestBinaryTag, ...) are unit-tested.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Backend = "cuda" | "vulkan" | "cpu" | "rocm";

export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "lazyllama");
}

export function serverInstallDir(): string {
  return join(dataDir(), "server");
}

export function receiptPath(): string {
  return join(serverInstallDir(), ".installed.json");
}

export interface Receipt {
  tag: string;
  backend: Backend;
  binary: string;
}

export function readReceipt(): Receipt | undefined {
  try {
    if (!existsSync(receiptPath())) return undefined;
    const raw = JSON.parse(readFileSync(receiptPath(), "utf8")) as Partial<Receipt>;
    if (typeof raw.binary === "string" && existsSync(raw.binary)) {
      return { tag: String(raw.tag ?? ""), backend: raw.backend ?? "cpu", binary: raw.binary };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Recursively find the llama-server binary under a directory.
export function findServerBinary(root: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile() && name === "llama-server") return p;
    if (st.isDirectory()) {
      const found = findServerBinary(p);
      if (found) return found;
    }
  }
  return undefined;
}

function commandOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commandOut(cmd: string, args: string[], timeoutMs = 15000): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
  } catch {
    return undefined;
  }
}

// -- hardware survey (pure parsers take text so tests use fixtures) --------

export interface GpuInfo {
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
  name: string;
}

export interface Hardware {
  prettyOs: string;
  arch: string;
  gpus: GpuInfo[];
  nvidiaDriverMajor?: number;
  hasVulkanLoader: boolean;
  vulkanDevices: string[];
  cpuFlags: string[];
}

export function parseOsRelease(text: string): string {
  const pretty = text.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
  if (pretty) return pretty.slice("PRETTY_NAME=".length).replace(/^"|"$/g, "");
  const id = text.split("\n").find((l) => l.startsWith("ID="));
  return id ? id.slice(3).replace(/^"|"$/g, "") : process.platform;
}

export function parseLspci(text: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of text.split("\n")) {
    if (!/vga|3d controller|display controller/i.test(line)) continue;
    const idMatch = line.match(/\[([0-9a-fA-F]{4}):[0-9a-fA-F]{4}\]/);
    const vendorId = idMatch?.[1]?.toLowerCase();
    const vendor = vendorId === "10de" ? "nvidia" : vendorId === "1002" ? "amd" : vendorId === "8086" ? "intel" : "other";
    const name = line.split(": ").slice(1).join(": ").replace(/\s*\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\].*$/, "").trim();
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

// Minimum NVIDIA driver major for our CUDA 12.8 prebuilt bundle.
export const CUDA_MIN_DRIVER_MAJOR = 565;

export function detectHardware(): Hardware {
  let prettyOs: string = process.platform;
  try {
    prettyOs = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    // non-Linux (macOS/Windows): keep platform id
  }
  if (process.platform === "darwin") {
    const arm = process.arch === "arm64";
    return {
      prettyOs: "macOS",
      arch: process.arch,
      gpus: arm ? [{ vendor: "apple", name: "Apple Silicon (Metal)" }] : [],
      hasVulkanLoader: false,
      vulkanDevices: [],
      cpuFlags: [],
    };
  }
  const lspci = commandOut("lspci", ["-nn"]);
  const gpus = lspci ? parseLspci(lspci) : [];
  const driverOut = commandOut("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]);
  const nvidiaDriverMajor = driverOut ? parseNvidiaDriverVersion(driverOut) : undefined;
  const ldconfig = commandOut("ldconfig", ["-p"]);
  const hasVulkanLoader = ldconfig !== undefined && ldconfig.includes("libvulkan.so");
  // NOTE: `vulkaninfo --version` is not a valid flag on all builds (exits 1);
  // go straight for --summary and treat failure as "no devices enumerated".
  const vulkanDevices = hasVulkanLoader ? parseVulkanDevices(commandOut("vulkaninfo", ["--summary"]) ?? "") : [];
  let cpuFlags: string[] = [];
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    const flagsLine = cpuinfo.split("\n").find((l) => l.startsWith("flags"));
    cpuFlags = flagsLine ? (flagsLine.split(":")[1] ?? "").trim().split(/\s+/) : [];
  } catch {
    // ignore
  }
  return { prettyOs, arch: process.arch, gpus, nvidiaDriverMajor, hasVulkanLoader, vulkanDevices, cpuFlags };
}

export interface BackendProposal {
  backend: Backend;
  reasons: string[];
  warnings: string[];
}

// Ordered rules: discrete NVIDIA with a fresh driver -> CUDA, any
// Vulkan-capable GPU (AMD/Intel, discrete or integrated) -> Vulkan,
// Apple Silicon -> Metal-inclusive default build, else CPU.
export function proposeBackend(hw: Hardware): BackendProposal {
  const warnings: string[] = [];
  const hasNvidia = hw.gpus.some((g) => g.vendor === "nvidia");
  if (hasNvidia && hw.nvidiaDriverMajor !== undefined) {
    if (hw.nvidiaDriverMajor >= CUDA_MIN_DRIVER_MAJOR) {
      return {
        backend: "cuda",
        reasons: [`NVIDIA GPU with working driver (major ${hw.nvidiaDriverMajor})`],
        warnings,
      };
    }
    warnings.push(
      `NVIDIA driver ${hw.nvidiaDriverMajor} predates CUDA 12.8 builds (need >= ${CUDA_MIN_DRIVER_MAJOR}); skipping CUDA`,
    );
  } else if (hasNvidia) {
    warnings.push("NVIDIA GPU present but nvidia-smi is unusable; skipping CUDA");
  }
  const gpuNames = hw.gpus.map((g) => g.name).join("; ");
  if (hw.vulkanDevices.length > 0) {
    return {
      backend: "vulkan",
      reasons: [`Vulkan device(s): ${hw.vulkanDevices.join("; ")}${gpuNames ? ` (pci: ${gpuNames})` : ""}`],
      warnings,
    };
  }
  if (hw.hasVulkanLoader && hw.gpus.some((g) => g.vendor === "amd" || g.vendor === "intel")) {
    return {
      backend: "vulkan",
      reasons: [`${gpuNames} with Vulkan loader present (devices not enumerated)`],
      warnings,
    };
  }
  if (hw.gpus.some((g) => g.vendor === "apple")) {
    return { backend: "cpu", reasons: ["Apple Silicon: default build includes Metal"], warnings };
  }
  const simd = ["avx512f", "avx2", "vnni", "neon"].filter((f) => hw.cpuFlags.includes(f));
  return {
    backend: "cpu",
    reasons: [hw.gpus.length > 0 ? `no accelerated path for: ${gpuNames}` : "no GPU detected", `CPU fallback${simd.length > 0 ? ` (${simd.join(", ")})` : ""}`],
    warnings,
  };
}

export function describeHardware(hw: Hardware): string {
  const lines = [`OS: ${hw.prettyOs} (${hw.arch})`];
  lines.push(hw.gpus.length > 0 ? `GPU: ${hw.gpus.map((g) => `[${g.vendor}] ${g.name}`).join(" | ")}` : "GPU: none detected");
  if (hw.nvidiaDriverMajor !== undefined) lines.push(`NVIDIA driver: ${hw.nvidiaDriverMajor}`);
  lines.push(`Vulkan loader: ${hw.hasVulkanLoader ? `yes (${hw.vulkanDevices.length} device(s))` : "no"}`);
  return lines.join("\n");
}

export function detectBackend(): Backend {
  return proposeBackend(detectHardware()).backend;
}

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

// Pick a prebuilt asset from a release listing. Token rules beat
// hardcoded names so renames upstream don't silently break us.
export function pickAsset(assets: ReleaseAsset[], backend: Backend): ReleaseAsset | undefined {
  const lower = (s: string) => s.toLowerCase();
  if (process.platform === "darwin") {
    // Default macOS build includes Metal; arch picks the slice.
    const archToken = process.arch === "arm64" ? "arm64" : "x64";
    return assets.find((a) => lower(a.name).includes("macos") && lower(a.name).includes(archToken));
  }
  if (process.platform === "win32") return undefined; // WSL or manual install for now
  if (backend === "cuda") {
    return assets.find((a) => lower(a.name).includes("cudart") && lower(a.name).includes("cuda-12"));
  }
  if (backend === "vulkan") {
    return assets.find(
      (a) => lower(a.name).includes("ubuntu") && lower(a.name).includes("vulkan") && lower(a.name).includes("x64"),
    );
  }
  if (backend === "rocm") {
    return assets.find(
      (a) => lower(a.name).includes("ubuntu") && lower(a.name).includes("rocm") && lower(a.name).includes("x64"),
    );
  }
  return assets.find(
    (a) =>
      lower(a.name).includes("ubuntu") &&
      lower(a.name).includes("x64") &&
      lower(a.name).endsWith(".tar.gz") &&
      !["cuda", "cudart", "rocm", "sycl", "openvino", "vulkan", "android"].some((t) => lower(a.name).includes(t)),
  );
}

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30", {
    headers: { "User-Agent": "lazyllama-installer", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API -> ${res.status}`);
  return (await res.json()) as GitHubRelease[];
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "lazyllama-installer" } });
  if (!res.ok || !res.body) throw new Error(`download -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function untar(archive: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
}

function verifyBinary(bin: string, backend: Backend): boolean {
  try {
    chmodSync(bin, 0o755);
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 30000 });
  } catch {
    return false;
  }
  // A GPU build that cannot see its device is a bad install: the flag
  // exists on llama-server and exits 0 while listing backends.
  if (backend === "cuda" || backend === "vulkan" || backend === "rocm") {
    try {
      const out = execFileSync(bin, ["--list-devices"], { encoding: "utf8", timeout: 30000 });
      const want = backend === "cuda" ? /cuda/i : backend === "rocm" ? /roc.?m|hip/i : /vulkan/i;
      if (!want.test(out)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function tryDownload(backend: Backend, pinTag?: string): Promise<string> {
  const releases = await fetchReleases();
  const tag = pinTag ?? latestBinaryTag(releases.map((r) => r.tag_name));
  if (!tag) throw new Error("no bNNNN release found on GitHub");
  const rel = releases.find((r) => r.tag_name === tag);
  if (!rel) throw new Error(`release ${tag} vanished`);
  const asset = pickAsset(
    rel.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
    backend,
  );
  if (!asset) throw new Error(`no ${backend} asset in ${tag}`);
  console.log(`downloading ${asset.name} ...`);
  const dest = join(serverInstallDir(), tag);
  const archive = join(tmpdir(), asset.name);
  await downloadTo(asset.url, archive);
  untar(archive, dest);
  const bin = findServerBinary(dest);
  if (!bin) throw new Error(`llama-server not found inside ${asset.name}`);
  if (!verifyBinary(bin, backend)) throw new Error(`${bin} failed verification (no usable ${backend} device?)`);
  const receipt: Receipt = { tag, backend, binary: bin };
  writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return bin;
}

function cmakeBuild(backend: Backend): string {
  const src = join(process.cwd(), "llama.cpp");
  if (!existsSync(join(src, "CMakeLists.txt"))) {
    throw new Error("llama.cpp/ checkout missing; cannot compile");
  }
  for (const tool of ["cmake", "make"]) {
    if (!commandOk(tool, ["--version"])) throw new Error(`build tool missing: ${tool}`);
  }
  const args = ["-B", "build"];
  if (backend === "vulkan" && commandOk("glslc", ["--version"])) {
    args.push("-DGGML_VULKAN=ON");
  }
  console.log(`cmake ${args.join(" ")} (llama.cpp/) ...`);
  execFileSync("cmake", args, { cwd: src, stdio: "inherit" });
  const nproc = (() => {
    try {
      return execFileSync("nproc", [], { encoding: "utf8" }).trim();
    } catch {
      return "4";
    }
  })();
  console.log("compiling llama-server (this takes a while) ...");
  execFileSync("cmake", ["--build", "build", "--config", "Release", "-j", nproc, "--target", "llama-server"], {
    cwd: src,
    stdio: "inherit",
  });
  const bin = join(src, "build", "bin", "llama-server");
  if (!verifyBinary(bin, backend)) throw new Error("compiled binary failed verification");
  return bin;
}

export interface InstallOptions {
  backend: Backend | "auto";
  tag?: string;
  force?: boolean;
  noBuild?: boolean;
  yes?: boolean;
}

const VALID_BACKENDS: Array<Backend | "auto"> = ["auto", "cpu", "vulkan", "cuda", "rocm"];

// Show the hardware survey + proposal and let the user override.
// Skipped with --backend, --yes, or a non-interactive stdin.
export async function confirmBackend(hw: Hardware, proposal: BackendProposal, opts: InstallOptions): Promise<Backend> {
  console.log(describeHardware(hw));
  for (const w of proposal.warnings) console.log(`warn: ${w}`);
  console.log(`proposed backend: ${proposal.backend} (${proposal.reasons.join("; ")})`);
  if (opts.backend !== "auto") return opts.backend;
  if (opts.yes || !process.stdin.isTTY) return proposal.backend;
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Use ${proposal.backend}? [Y/n or cuda|vulkan|cpu|rocm] `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
  if (answer === "" || answer === "y" || answer === "yes") return proposal.backend;
  if (answer === "cuda" || answer === "vulkan" || answer === "cpu" || answer === "rocm") return answer;
  console.log("keeping it simple: cpu");
  return "cpu";
}

export async function runInstaller(opts: InstallOptions): Promise<string> {
  mkdirSync(serverInstallDir(), { recursive: true });
  if (!opts.force) {
    const existing = readReceipt();
    if (existing) {
      console.log(`already installed: ${existing.binary} (${existing.tag}/${existing.backend})`);
      return existing.binary;
    }
  }
  const hw = detectHardware();
  const backend = await confirmBackend(hw, proposeBackend(hw), opts);
  console.log(`backend: ${backend}`);
  const backends: Backend[] = backend === "cpu" ? ["cpu"] : [backend, "cpu"];
  for (const b of backends) {
    try {
      const bin = await tryDownload(b, opts.tag);
      console.log(`installed: ${bin}`);
      return bin;
    } catch (err) {
      console.log(`download (${b}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts.noBuild) throw new Error("downloads failed and --no-build skips compilation");
  const bin = cmakeBuild("cpu");
  console.log(`compiled: ${bin}`);
  return bin;
}

function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = { backend: "auto" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--backend" && argv[i + 1]) {
      const b = argv[i + 1] as string;
      if ((VALID_BACKENDS as string[]).includes(b)) opts.backend = b as Backend | "auto";
      i += 1;
    } else if (a === "--tag" && argv[i + 1]) {
      opts.tag = argv[i + 1] as string;
      i += 1;
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--no-build") {
      opts.noBuild = true;
    } else if (a === "--yes" || a === "-y") {
      opts.yes = true;
    }
  }
  return opts;
}

if (import.meta.main) {
  await runInstaller(parseArgs(process.argv.slice(2)));
}
