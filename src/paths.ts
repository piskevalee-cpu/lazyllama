// Machine setup: where the app lives, how `lazyllama` gets onto PATH, and how
// much room is left on disk. Every path-taking function takes its roots as
// arguments so tests can point the whole flow at a temp directory instead of
// the real home.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { backendDef } from "./backends.js";

// -- XDG roots ------------------------------------------------------------

export function dataHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env["XDG_DATA_HOME"];
  return xdg && xdg.length > 0 ? xdg : join(home, ".local", "share");
}

export function binDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env["XDG_BIN_HOME"];
  return xdg && xdg.length > 0 ? xdg : join(home, ".local", "bin");
}

/** Standalone copy of the app, so the launcher survives moving the clone. */
export function appDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), "lazyllama", "app");
}

/** llama.cpp checkout used by the build-from-source fallback. */
export function sourceDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), "lazyllama", "llama.cpp");
}

export function appEntry(target: string): string {
  return join(target, "src", "index.ts");
}

// -- shell quoting and the launcher shim ----------------------------------

/** POSIX single-quoting: safe for any path, including spaces and quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The launcher. A `bun` found on PATH wins so the shim keeps working after a
 * bun upgrade; the absolute interpreter path is the fallback for setups where
 * bun is only reachable through its installer shim.
 */
export function shimScript(entry: string, bunPath?: string): string {
  const bun = bunPath && bunPath.length > 0 ? bunPath : "bun";
  return [
    "#!/bin/sh",
    "# lazyllama launcher. Installed by `bun run install`; safe to delete.",
    `BUN=\${LAZYLLAMA_BUN:-${bun}}`,
    `exec "$BUN" ${shellQuote(entry)} "$@"`,
    "",
  ].join("\n");
}

export function shimPath(dir: string, name = "lazyllama"): string {
  return join(dir, name);
}

/** Write (or refresh) the launcher. Returns the path. */
export function writeShim(dir: string, entry: string, bunPath?: string): string {
  mkdirSync(dir, { recursive: true });
  const target = shimPath(dir);
  writeFileSync(target, shimScript(entry, bunPath), "utf8");
  chmodSync(target, 0o755);
  return target;
}

// -- PATH ----------------------------------------------------------------

export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["PATH"] ?? "";
  return raw.split(delimiter).filter((entry) => entry.length > 0);
}

export function pathHasDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(dir);
  return pathEntries(env).some((entry) => resolve(entry) === target);
}

export type ShellName = "bash" | "zsh" | "fish" | "sh" | "unknown";

export function shellName(env: NodeJS.ProcessEnv = process.env): ShellName {
  const shell = basename(env["SHELL"] ?? "");
  if (shell === "bash" || shell === "zsh" || shell === "fish" || shell === "sh") return shell;
  return "unknown";
}

/** The file the shell actually reads on startup. */
export function rcFile(shell: ShellName, home: string = homedir()): string {
  switch (shell) {
    case "zsh":
      return join(home, ".zshrc");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
    case "sh":
      return join(home, ".profile");
    case "bash":
    case "unknown":
    default:
      return join(home, ".bashrc");
  }
}

export const RC_MARKER = "# added by `bun run install` (lazyllama)";

/** The exact line that would be appended, so the wizard can show it first. */
export function pathExportLine(dir: string, shell: ShellName): string {
  return shell === "fish"
    ? `set -gx PATH ${shellQuote(dir)} $PATH`
    : `export PATH=${shellQuote(`${dir}:$PATH`)}`;
}

export type RcResult = "added" | "already-present" | "failed";

/** Append the export line once, guarded by a marker comment. */
export function appendPathEntry(rc: string, dir: string, shell: ShellName): RcResult {
  const line = pathExportLine(dir, shell);
  let current = "";
  try {
    current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  } catch {
    return "failed";
  }
  if (current.includes(line)) return "already-present";
  try {
    mkdirSync(dirname(rc), { recursive: true });
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(rc, `${prefix}${RC_MARKER}\n${line}\n`, "utf8");
    return "added";
  } catch {
    return "failed";
  }
}

// -- disk ----------------------------------------------------------------

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  /** free / total, 0..1 */
  usedFraction: number;
}

export function diskUsage(path: string): DiskUsage | undefined {
  try {
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const free = Number(stats.bavail) * blockSize;
    if (!Number.isFinite(total) || total <= 0) return undefined;
    return { totalBytes: total, freeBytes: free, usedFraction: Math.min(1, Math.max(0, 1 - free / total)) };
  } catch {
    return undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Round numbers read better without a decimal: "30 MiB", not "30.0 MiB".
  const digits = Number.isInteger(value) || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

// -- standalone app copy -------------------------------------------------

/** Only what the app needs at runtime: sources and manifests. */
export const APP_COPY_ENTRIES = ["src", "package.json", "package-lock.json", "tsconfig.json"];

export interface AppCopyResult {
  dir: string;
  entry: string;
  /** True when node_modules/@opentui/core resolved in the copy. */
  depsReady: boolean;
}

const yieldToLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

/**
 * Every package the app needs at runtime, resolved from the checkout's own
 * node_modules: the app's dependencies, plus what they pull in, plus the
 * prebuilt binary for this platform.
 *
 * Copying the resolved tree beats running `bun install` in the copy: the
 * launcher gets the exact OpenTUI build the user is already running, and the
 * install works offline. A lockfile cannot be used for this because the repo
 * carries an npm lockfile that bun insists on migrating.
 */
/** Type-only peers that nothing imports at runtime (and which are huge). */
const RUNTIME_EXCLUSIONS = new Set(["typescript"]);

export function runtimeDependencies(repoRoot: string, names: string[]): string[] {
  const found = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (found.has(name) || RUNTIME_EXCLUSIONS.has(name)) continue;
    const dir = join(repoRoot, "node_modules", name);
    if (!existsSync(dir)) continue;
    found.add(name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    for (const deps of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      if (!deps) continue;
      for (const dep of Object.keys(deps)) queue.push(dep);
    }
  }
  return [...found].sort();
}

function installRuntimeDeps(repoRoot: string, target: string): boolean {
  const manifest = readManifest(repoRoot);
  const appDeps = Object.keys(manifest?.dependencies ?? {});
  const names = runtimeDependencies(repoRoot, appDeps);
  if (names.length === 0) return false;
  for (const name of names) {
    mkdirSync(join(target, "node_modules", dirname(name)), { recursive: true });
    cpSync(join(repoRoot, "node_modules", name), join(target, "node_modules", name), { recursive: true });
  }
  return true;
}

/** True when the copy can actually import the renderer. */
export function hasRuntimeDeps(target: string): boolean {
  return existsSync(join(target, "node_modules", "@opentui", "core"));
}

/**
 * Copy the app somewhere stable and link it to PATH. `bun install
 * --production` runs in the copy so the clone can be deleted afterwards.
 *
 * Asynchronous on purpose: the wizard is showing this step, and a synchronous
 * copy would freeze the renderer (and swallow keys) for seconds. Each step
 * yields to the event loop so frames keep painting and input still lands.
 */
export async function installAppCopy(
  repoRoot: string,
  target: string,
  onProgress?: (label: string, fraction: number) => void,
): Promise<AppCopyResult> {
  mkdirSync(target, { recursive: true });
  for (const [index, entry] of APP_COPY_ENTRIES.entries()) {
    const from = join(repoRoot, entry);
    if (existsSync(from)) {
      onProgress?.(`copying ${entry}`, index / (APP_COPY_ENTRIES.length + 1));
      cpSync(from, join(target, entry), { recursive: true });
    }
    await yieldToLoop();
  }
  onProgress?.("copying dependencies", APP_COPY_ENTRIES.length / (APP_COPY_ENTRIES.length + 1));
  await yieldToLoop();
  let depsReady = installRuntimeDeps(repoRoot, target);
  if (!depsReady) {
    // No resolvable tree in the checkout: fall back to a real install. No
    // --frozen-lockfile: the repo carries an npm lockfile that bun would want
    // to migrate, which it refuses to do while frozen.
    try {
      const code = await new Promise<number>((done, fail) => {
        const child = spawn("bun", ["install", "--production"], { cwd: target, stdio: "ignore" });
        child.on("error", (err) => fail(err));
        child.on("close", (exit) => done(exit ?? 1));
      });
      depsReady = code === 0 && hasRuntimeDeps(target);
    } catch {
      depsReady = false;
    }
  }
  onProgress?.(depsReady ? "launcher ready" : "dependencies missing", 1);
  return { dir: target, entry: appEntry(target), depsReady };
}

/** The bun binary to bake into the shim: PATH first, then this process. */
export function bunBinary(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  const raw = env["PATH"] ?? "";
  for (const dir of raw.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  return basename(execPath) === "bun" ? execPath : "bun";
}

export function relativeToRepo(path: string, repoRoot: string): string {
  return isAbsolute(path) && path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\//, "") : path;
}

/** Human summary of what a backend costs on disk, for the picker. */
export function downloadEstimateMiB(backend: Parameters<typeof backendDef>[0]): number {
  return backendDef(backend).approxMiB;
}
