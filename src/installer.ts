// `bun run install:server` — zero-setup llama-server provisioning.
//
// Strategy (in order):
//   1. Detect the hardware and propose a backend (see ./backends.ts).
//   2. Download the matching prebuilt tarball from the latest bNNNN llama.cpp
//      release into the XDG data dir and verify `--version` plus, for GPU
//      builds, that `--list-devices` actually lists the device.
//   3. Walk the backend's fallback chain when a slice is missing or unusable.
//   4. Last resort: build from source (a shallow llama.cpp clone, cmake).
//
// LazyLlama itself never provisions or compiles: the full wizard in
// ./install.ts is explicit-only, and the app never calls any of this.
// Pure helpers (pickAsset, proposeBackend, ...) live in ./backends.ts and are
// unit-tested; only the network and process work is here.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  detectHardware,
  describeHardware,
  deviceVisible,
  fallbackChain,
  proposeBackend,
  backendDef,
  backendLabel,
  currentArch,
  currentPlatform,
  isBinaryTag,
  latestBinaryTag,
  pickAsset,
  type Backend,
  type BackendProposal,
  type Hardware,
} from "./backends.js";
import { dataHome, sourceDir } from "./paths.js";

// Re-exported so the app, the tests and `bun run install:server` keep one
// import site for provisioning concerns.
export * from "./backends.js";

export function dataDir(): string {
  return join(dataHome(), "lazyllama");
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
  arch: string;
  platform: string;
  installedAt: string;
}

export function readReceipt(): Receipt | undefined {
  try {
    if (!existsSync(receiptPath())) return undefined;
    const raw = JSON.parse(readFileSync(receiptPath(), "utf8")) as Partial<Receipt>;
    if (typeof raw.binary === "string" && existsSync(raw.binary)) {
      return {
        tag: String(raw.tag ?? ""),
        backend: (raw.backend ?? "cpu") as Backend,
        binary: raw.binary,
        arch: String(raw.arch ?? currentArch()),
        platform: String(raw.platform ?? currentPlatform()),
        installedAt: String(raw.installedAt ?? ""),
      };
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

// -- progress -------------------------------------------------------------

export type InstallPhase = "resolve" | "download" | "extract" | "verify" | "clone" | "build" | "done";

export interface InstallProgress {
  phase: InstallPhase;
  label: string;
  /** 0..1 when known; undefined for indeterminate phases. */
  fraction?: number;
  receivedBytes?: number;
  totalBytes?: number;
  detail?: string;
}

export type ProgressFn = (progress: InstallProgress) => void;

export interface AbortSignalLike {
  aborted: boolean;
}

function abortError(): Error {
  const err = new Error("aborted") as Error & { name: string };
  err.name = "AbortError";
  return err;
}

function checkAbort(signal?: AbortSignalLike): void {
  if (signal?.aborted) throw abortError();
}

// -- release plumbing -----------------------------------------------------

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export async function fetchReleases(): Promise<GitHubRelease[]> {
  const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30", {
    headers: { "User-Agent": "lazyllama-installer", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API -> ${res.status}`);
  return (await res.json()) as GitHubRelease[];
}

/**
 * Stream an asset to disk. The CUDA bundle is ~570 MB, so the body is consumed
 * incrementally: progress can be reported, memory stays flat, and Esc can cut
 * the transfer short.
 */
export async function downloadTo(
  url: string,
  dest: string,
  onProgress?: ProgressFn,
  signal?: AbortSignalLike,
): Promise<number> {
  const res = await fetch(url, { headers: { "User-Agent": "lazyllama-installer" } });
  if (!res.ok || !res.body) throw new Error(`download -> ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const fd = openSync(dest, "w");
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      checkAbort(signal);
      writeSync(fd, chunk);
      received += chunk.length;
      onProgress?.({
        phase: "download",
        label: `downloading ${basenameOf(url)}`,
        fraction: total > 0 ? Math.min(1, received / total) : undefined,
        receivedBytes: received,
        totalBytes: total > 0 ? total : undefined,
      });
    }
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  closeSync(fd);
  return received;
}

function basenameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

function untar(archive: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", dest], { stdio: "ignore" });
}

export function verifyBinary(bin: string, backend: Backend): boolean {
  try {
    chmodSync(bin, 0o755);
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 30000 });
  } catch {
    return false;
  }
  // A GPU build that cannot see its device is a bad install: the flag exists on
  // llama-server and exits 0 while listing backends.
  const def = backendDef(backend);
  if (!def.deviceTokens) return true;
  try {
    const out = execFileSync(bin, ["--list-devices"], { encoding: "utf8", timeout: 30000 });
    return deviceVisible(backend, out);
  } catch {
    return false;
  }
}

export interface AttemptResult {
  binary: string;
  tag: string;
  backend: Backend;
  attempts: Array<{ backend: Backend; ok: boolean; error?: string }>;
}

export async function provision(
  backend: Backend,
  opts: { tag?: string; force?: boolean; onProgress?: ProgressFn; signal?: AbortSignalLike } = {},
): Promise<AttemptResult> {
  const { onProgress, signal } = opts;
  mkdirSync(serverInstallDir(), { recursive: true });
  const attempts: AttemptResult["attempts"] = [];
  onProgress?.({ phase: "resolve", label: `resolving the ${backendLabel(backend)} release` });
  let releases: GitHubRelease[];
  try {
    releases = await fetchReleases();
  } catch (err) {
    throw new Error(`cannot reach the GitHub releases API: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tag = opts.tag ?? latestTag(releases);
  if (!tag) throw new Error("no bNNNN release found on GitHub");
  const release = releases.find((r) => r.tag_name === tag);
  if (!release) throw new Error(`release ${tag} vanished`);
  for (const candidate of fallbackChain(backend)) {
    checkAbort(signal);
    const asset = pickAsset(
      release.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
      candidate,
    );
    if (!asset) {
      attempts.push({ backend: candidate, ok: false, error: `no ${candidate} asset in ${tag}` });
      continue;
    }
    const dest = join(serverInstallDir(), tag);
    const archive = join(tmpdir(), asset.name);
    try {
      checkAbort(signal);
      await downloadTo(asset.url, archive, onProgress, signal);
      checkAbort(signal);
      onProgress?.({ phase: "extract", label: `extracting ${asset.name}` });
      untar(archive, dest);
      const bin = findServerBinary(dest);
      if (!bin) throw new Error("llama-server not found inside the archive");
      onProgress?.({ phase: "verify", label: `verifying ${candidate}` });
      if (!verifyBinary(bin, candidate)) throw new Error(`failed verification (no usable ${candidate} device?)`);
      const receipt: Receipt = {
        tag,
        backend: candidate,
        binary: bin,
        arch: currentArch(),
        platform: currentPlatform(),
        installedAt: new Date().toISOString(),
      };
      writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n", "utf8");
      attempts.push({ backend: candidate, ok: true });
      onProgress?.({ phase: "done", label: `installed ${backendLabel(candidate)}`, fraction: 1 });
      return { binary: bin, tag, backend: candidate, attempts };
    } catch (err) {
      attempts.push({
        backend: candidate,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new Error(
    `no usable build for ${backendLabel(backend)}: ${attempts.map((a) => `${a.backend} (${a.error ?? "failed"})`).join(", ")}`,
  );
}

function latestTag(releases: GitHubRelease[]): string | undefined {
  return latestBinaryTag(releases.map((r) => r.tag_name));
}

// -- build from source ----------------------------------------------------

const LLAMA_CPP_URL = "https://github.com/ggml-org/llama.cpp";

/** Shallow clone into the data dir: a standalone install has no ./llama.cpp. */
export function ensureLlamaCpp(dest: string = sourceDir(), onProgress?: ProgressFn): string {
  if (existsSync(join(dest, "CMakeLists.txt"))) return dest;
  onProgress?.({ phase: "clone", label: "cloning llama.cpp" });
  mkdirSync(dirnameOf(dest), { recursive: true });
  execFileSync("git", ["clone", "--depth", "1", LLAMA_CPP_URL, dest], { stdio: "ignore" });
  return dest;
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function cmakeBuild(
  backend: Backend,
  opts: { src?: string; onProgress?: ProgressFn; signal?: AbortSignalLike } = {},
): string {
  const src = ensureLlamaCpp(opts.src, opts.onProgress);
  if (!existsSync(join(src, "CMakeLists.txt"))) throw new Error("llama.cpp checkout missing; cannot compile");
  for (const tool of ["cmake", "make"]) {
    if (!commandOk(tool, ["--version"])) throw new Error(`build tool missing: ${tool}`);
  }
  const args = ["-B", "build"];
  if (backendDef(backend).id === "vulkan" && commandOk("glslc", ["--version"])) args.push("-DGGML_VULKAN=ON");
  if (backendDef(backend).id === "cuda-12.8" || backendDef(backend).id === "cuda-13.4") {
    args.push("-DGGML_CUDA=ON");
  }
  opts.onProgress?.({ phase: "build", label: "configuring with cmake" });
  execFileSync("cmake", args, { cwd: src, stdio: "ignore" });
  const nproc = (() => {
    try {
      return execFileSync("nproc", [], { encoding: "utf8" }).trim();
    } catch {
      return "4";
    }
  })();
  opts.onProgress?.({ phase: "build", label: "compiling llama-server, this takes a while" });
  execFileSync("cmake", ["--build", "build", "--config", "Release", "-j", nproc, "--target", "llama-server"], {
    cwd: src,
    stdio: "ignore",
  });
  const bin = join(src, "build", "bin", "llama-server");
  if (!verifyBinary(bin, backend)) throw new Error("compiled binary failed verification");
  const receipt: Receipt = {
    tag: "source",
    backend,
    binary: bin,
    arch: currentArch(),
    platform: currentPlatform(),
    installedAt: new Date().toISOString(),
  };
  mkdirSync(serverInstallDir(), { recursive: true });
  writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  opts.onProgress?.({ phase: "done", label: "compiled llama-server", fraction: 1 });
  return bin;
}

// -- non-interactive entry ------------------------------------------------

export interface InstallOptions {
  backend: Backend | "auto";
  tag?: string;
  force?: boolean;
  noBuild?: boolean;
  yes?: boolean;
  onProgress?: ProgressFn;
  signal?: AbortSignalLike;
}

/** Show the hardware survey and let the user override; skipped with --backend. */
export async function confirmBackend(
  hw: Hardware,
  proposal: BackendProposal,
  opts: InstallOptions,
): Promise<Backend> {
  console.log(describeHardware(hw));
  for (const w of proposal.warnings) console.log(`warn: ${w}`);
  console.log(`proposed backend: ${backendLabel(proposal.backend)} (${proposal.reasons.join("; ")})`);
  if (opts.backend !== "auto") return opts.backend;
  if (opts.yes || !process.stdin.isTTY) return proposal.backend;
  const options = Object.values(backendDefAll()).filter((id) => id !== "source");
  const answer = await new Promise<string>((resolve_) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Use ${proposal.backend}? [Y/n or ${options.join("|")}] `, (a) => {
      rl.close();
      resolve_(a.trim().toLowerCase());
    });
  });
  if (answer === "" || answer === "y" || answer === "yes") return proposal.backend;
  if (isBackend(answer)) return answer;
  console.log("keeping it simple: cpu");
  return "cpu";
}

function backendDefAll(): Record<string, Backend> {
  return Object.fromEntries(
    (["cpu", "vulkan", "cuda-12.8", "cuda-13.4", "rocm", "sycl-fp16", "sycl-fp32", "openvino", "metal"] as Backend[]).map(
      (id) => [id, id],
    ),
  );
}

function isBackend(value: string): value is Backend {
  return value in backendDefAll();
}

export async function runInstaller(opts: InstallOptions): Promise<string> {
  mkdirSync(serverInstallDir(), { recursive: true });
  if (!opts.force) {
    const existing = readReceipt();
    if (existing) {
      opts.onProgress?.({ phase: "done", label: `already installed: ${existing.binary}` });
      return existing.binary;
    }
  }
  const hw = detectHardware();
  const backend = await confirmBackend(hw, proposeBackend(hw), opts);
  try {
    const result = await provision(backend, opts);
    return result.binary;
  } catch (err) {
    if (opts.noBuild || (err instanceof Error && err.name === "AbortError")) throw err;
    opts.onProgress?.({ phase: "build", label: "no prebuilt build worked, falling back to a local compile" });
    return cmakeBuild("cpu", { onProgress: opts.onProgress, signal: opts.signal });
  }
}

export function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = { backend: "auto" };
  const all = [...Object.keys(backendDefAll()), "source"] as string[];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--backend" && argv[i + 1]) {
      const b = argv[i + 1];
      if (b === "auto" || all.includes(b)) opts.backend = b as Backend | "auto";
      i += 1;
    } else if (a === "--tag" && argv[i + 1]) {
      opts.tag = argv[i + 1];
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
  const opts = parseArgs(process.argv.slice(2));
  opts.onProgress = (p) => {
    const pct = p.fraction !== undefined ? ` ${Math.round(p.fraction * 100)}%` : "";
    console.log(`[${p.phase}] ${p.label}${pct}`);
  };
  await runInstaller(opts);
}
