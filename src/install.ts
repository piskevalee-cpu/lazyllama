// `bun run setup` — the full setup: hardware survey, backend choice, models
// directory, server provisioning, and putting `lazyllama` on PATH.
//
// This is the only place that provisions anything, and only when a person runs
// it: the app itself never downloads, compiles or writes to PATH. Without a
// TTY (CI, Docker, a piped shell) the same steps run as plain text so the
// wizard is never the reason a script fails.

import { execFileSync, spawnSync } from "node:child_process";

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assessBackends,
  backendLabel,
  detectHardware,
  describeHardware,
  proposeBackend,
  type Backend,
  type BackendOption,
  type Hardware,
} from "./backends.js";
import { cmakeBuild, provision, readReceipt, type InstallProgress } from "./installer.js";
import { scanLocalModels } from "./models.js";
import {
  appDir,
  appEntry,
  appendPathEntry,
  binDir,
  bunBinary,
  diskUsage,
  formatBytes,
  installAppCopy,
  pathExportLine,
  pathHasDir,
  rcFile,
  shellName,
  writeShim,
  type ShellName,
} from "./paths.js";
import { splashFrame } from "./splash.js";
import { defaultModelsDir, expandHome, readSettings, writeSettings } from "./settings.js";
import {
  hardwareRows,
  InstallView,
  STEP_ORDER,
  type ModelsDirState,
  type PathState,
  type SummarySection,
} from "./ui/installView.js";
import { createLazyRenderer, destroyRenderer } from "./ui/opentui.js";
import { themeForMode } from "./ui/theme.js";

export interface InstallCliOptions {
  help?: boolean;
  version?: boolean;
  backend?: Backend | "auto";
  modelsDir?: string;
  tag?: string;
  force?: boolean;
  noBuild?: boolean;
  noPath?: boolean;
  /** Point the launcher at this checkout instead of copying the app. */
  link?: boolean;
  yes?: boolean;
  launch?: boolean;
  mouse?: boolean;
}

const BACKEND_IDS: Backend[] = [
  "cpu",
  "vulkan",
  "cuda-12.8",
  "cuda-13.4",
  "rocm",
  "sycl-fp16",
  "sycl-fp32",
  "openvino",
  "metal",
  "source",
];

// The installer ships with the checkout, so its root is the working directory
// `bun run setup` starts in.
const REPO_ROOT = resolve(process.cwd());

class QuitError extends Error {}

export function parseArgs(argv: string[]): InstallCliOptions {
  const out: InstallCliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--version" || arg === "-V") {
      out.version = true;
    } else if (arg === "--backend" && next) {
      out.backend = next === "auto" || (BACKEND_IDS as string[]).includes(next) ? (next as Backend | "auto") : "auto";
      i += 1;
    } else if (arg === "--models-dir" && next) {
      out.modelsDir = next;
      i += 1;
    } else if (arg === "--tag" && next) {
      out.tag = next;
      i += 1;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg === "--no-build") {
      out.noBuild = true;
    } else if (arg === "--no-path") {
      out.noPath = true;
    } else if (arg === "--link") {
      out.link = true;
    } else if (arg === "--yes" || arg === "-y") {
      out.yes = true;
    } else if (arg === "--launch") {
      out.launch = true;
    } else if (arg === "--no-mouse") {
      out.mouse = false;
    }
  }
  return out;
}

// -- models directory -----------------------------------------------------

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function canWrite(dir: string): boolean {
  try {
    execFileSync("sh", ["-c", `test -w "${dir}"`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Everything the wizard shows about a models directory, before creating it. */
export function inspectModelsDir(raw: string): ModelsDirState {
  const trimmed = raw.trim();
  const resolved = expandHome(trimmed.length > 0 ? trimmed : defaultModelsDir());
  const exists = existsSync(resolved);
  let writable: boolean;
  if (exists) {
    // A directory is writable when a probe file can be created and removed.
    const probe = join(resolved, `.lazyllama-write-probe-${process.pid}`);
    try {
      execFileSync("sh", ["-c", `touch "${probe}" && rm -f "${probe}"`], { stdio: "ignore" });
      writable = true;
    } catch {
      writable = false;
    }
  } else {
    // mkdir -p only needs the closest existing parent to be writable.
    let parent = resolved;
    let up: string | undefined;
    for (;;) {
      const next = join(parent, "..");
      if (next === parent) break;
      parent = next;
      if (existsSync(parent)) {
        up = parent;
        break;
      }
    }
    writable = up !== undefined && canWrite(up);
  }
  const usage = diskUsage(exists ? resolved : dirnameOf(resolved));
  return {
    raw,
    resolved,
    exists,
    writable,
    freeBytes: usage?.freeBytes,
    usedFraction: usage?.usedFraction,
    ggufCount: scanLocalModels(resolved).length,
  };
}

export function ensureModelsDir(state: ModelsDirState): ModelsDirState {
  if (state.exists) return { ...state, created: false };
  try {
    mkdirSync(state.resolved, { recursive: true });
    return { ...inspectModelsDir(state.raw), created: true };
  } catch (err) {
    return { ...state, error: err instanceof Error ? err.message : String(err) };
  }
}

// -- launcher -------------------------------------------------------------

export interface PathPlan {
  shim: string;
  bin: string;
  onPath: boolean;
  shell: ShellName;
  rc: string;
  line: string;
  entry: string;
  depsReady: boolean;
  target: string;
}

export async function planLauncher(
  opts: InstallCliOptions,
  onProgress?: (label: string, fraction: number) => void,
): Promise<PathPlan> {
  const bin = binDir();
  const home = homedir();
  const shell = shellName();
  const linked = opts.link === true;
  const target = linked ? REPO_ROOT : appDir();
  let entry = appEntry(target);
  let depsReady = existsSync(join(REPO_ROOT, "node_modules", "@opentui", "core"));
  if (!linked) {
    // Copy the app out of the clone so the launcher keeps working if the repo
    // moves or is deleted, and so `lazyllama` runs from any directory.
    const copy = await installAppCopy(REPO_ROOT, target, onProgress);
    entry = copy.entry;
    depsReady = copy.depsReady;
  }
  return {
    shim: join(bin, "lazyllama"),
    bin,
    onPath: pathHasDir(bin),
    shell,
    rc: rcFile(shell, home),
    line: pathExportLine(bin, shell),
    entry,
    depsReady,
    target,
  };
}

function summarySections(
  installed: { backend: Backend; tag: string; binary: string },
  models: ModelsDirState,
  plan: PathPlan | undefined,
  pathAnswered: boolean,
): SummarySection[] {
  const sections: SummarySection[] = [
    {
      title: "server",
      rows: [
        { label: "backend", value: `${backendLabel(installed.backend)} (${installed.tag})` },
        { label: "binary", value: installed.binary },
      ],
    },
    {
      title: "models",
      rows: [
        { label: "directory", value: models.resolved },
        {
          label: "contents",
          value: models.ggufCount === 0 ? "no .gguf files yet, drop one in" : `${models.ggufCount} .gguf found`,
          tone: "muted",
        },
      ],
    },
  ];
  if (plan) {
    sections.push({
      title: "launcher",
      rows: [
        { label: "command", value: "lazyllama" },
        { label: "script", value: plan.shim },
        {
          label: "path",
          value: plan.onPath
            ? `${plan.bin} is on your PATH`
            : pathAnswered
              ? "not on your PATH, add the line from the previous step"
              : `${plan.bin} is not on your PATH`,
          tone: plan.onPath ? "normal" : "muted",
        },
      ],
    });
  } else {
    sections.push({ title: "launcher", rows: [{ label: "command", value: "bun run dev", tone: "muted" }] });
  }
  return sections;
}

// -- wizard ---------------------------------------------------------------

async function runWizard(opts: InstallCliOptions): Promise<number> {
  const { renderer, themeMode } = await createLazyRenderer({ mouse: opts.mouse });
  const theme = themeForMode(themeMode);
  const abort = { aborted: false };
  const started = Date.now();
  const storedModels = opts.modelsDir ?? readSettings().modelsDir ?? abbreviate(defaultModelsDir());

  // The survey shells out to lspci, nvidia-smi, ldconfig and vulkaninfo, which
  // blocks for seconds on a slow machine. Everything below therefore has to be
  // ready *before* it runs: the splash paints, the key handler is attached, and
  // the wizard only advances to the first question once the survey is in.
  let hardware: Hardware | undefined;
  let options: BackendOption[] = [];
  let chosen: Backend = "cpu";
  let models: ModelsDirState = inspectModelsDir(storedModels);
  let plan: PathPlan | undefined;
  let pathAnswered = false;
  let launch = opts.launch === true;
  let quit = false;
  let advance: (() => void) | undefined;

  const checkpoint = async (): Promise<void> => {
    await new Promise<void>((resolveWait) => {
      advance = resolveWait;
    });
    if (quit) throw new QuitError();
  };

  const view = new InstallView(
    renderer,
    {
      onBackendPick: (id) => {
        chosen = id;
        advance?.();
      },
      onModelsDirInput: (raw) => {
        models = inspectModelsDir(raw);
        view.setModelsDir(models);
      },
      onModelsDirSubmit: (raw) => {
        models = ensureModelsDir(inspectModelsDir(raw));
        view.setModelsDir(models);
        advance?.();
      },
      onPathAnswer: (append) => {
        if (plan && append) appendPathEntry(plan.rc, plan.bin, plan.shell);
        if (plan) plan = { ...plan, onPath: plan.onPath || append };
        pathAnswered = true;
        advance?.();
      },
      onAdvance: () => advance?.(),
      onLaunch: () => {
        launch = true;
        advance?.();
      },
      onCancelInstall: () => {
        abort.aborted = true;
      },
      onRescan: () => {
        hardware = detectHardware();
        options = assessBackends(hardware);
        view.setHardware(hardwareRows(hardware));
        view.setBackends(options, chosen);
      },
      onBack: () => advance?.(),
      onQuit: () => {
        quit = true;
        advance?.();
      },
    },
    theme,
  );

  // Attached before the survey: a key pressed during the splash must be heard
  // even though no step is listening for it yet.
  const keyHandler = (key: Parameters<typeof view.handleKey>[0]): void => view.handleKey(key);
  renderer.keyInput.on("keypress", keyHandler);
  const meter = { ramp: theme.meter, track: theme.meterTrack } as const;

  try {
    view.show("splash");
    const splashTimer = setInterval(() => {
      view.renderSplash(splashFrame(Date.now() - started, theme.primary, { ...meter }));
    }, 90);
    // Two frames of splash before the survey blocks the loop.
    await new Promise((done) => setTimeout(done, 250));
    hardware = detectHardware();
    clearInterval(splashTimer);
    options = assessBackends(hardware);
    chosen =
      opts.backend && opts.backend !== "auto"
        ? opts.backend
        : (options.find((option) => option.recommended)?.def.id ?? "cpu");

    view.setSteps(opts.noPath ? STEP_ORDER.filter((s) => s !== "path") : STEP_ORDER);
    view.setHardware(hardwareRows(hardware));
    view.show("hardware", backendLabel(chosen));
    await checkpoint();

    view.setBackends(options, chosen);
    view.show("backend", backendLabel(chosen));
    await checkpoint();

    view.setModelsDir(models);
    view.show("models", models.exists ? "found" : "new");
    await checkpoint();

    // Provision.
    view.show("install", backendLabel(chosen));
    const onProgress = (progress: InstallProgress): void => {
      const detail =
        progress.receivedBytes !== undefined
          ? `${formatBytes(progress.receivedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ""}${
              progress.fraction !== undefined ? ` · ${Math.round(progress.fraction * 100)}%` : ""
            }`
          : (progress.detail ?? "");
      view.setProgress(progress.label, progress.fraction, detail);
    };
    let installed: { backend: Backend; tag: string; binary: string };
    try {
      installed =
        chosen === "source"
          ? { backend: "cpu", tag: "source", binary: cmakeBuild("cpu", { onProgress, signal: abort }) }
          : await provision(chosen, { tag: opts.tag, force: opts.force, onProgress, signal: abort });
    } catch (err) {
      if (opts.noBuild || abort.aborted) throw err;
      onProgress({ phase: "build", label: "no prebuilt build worked, compiling from source" });
      installed = { backend: "cpu", tag: "source", binary: cmakeBuild("cpu", { onProgress, signal: abort }) };
    }

    // Launcher and PATH.
    if (!opts.noPath) {
      view.setProgress("preparing the launcher", undefined, "");
      plan = await planLauncher(opts, (label, fraction) => {
        view.setProgress(label, fraction, "");
      });
      writeShim(plan.bin, plan.entry, bunBinary());
      const pathState: PathState = {
        shim: plan.shim,
        binDir: plan.bin,
        onPath: plan.onPath,
        shell: plan.shell,
        rc: plan.rc,
        line: plan.line,
      };
      if (plan.onPath) {
        pathAnswered = true;
      } else {
        view.setPath(pathState);
        view.show("path", "not on PATH");
        await checkpoint();
      }
      view.setPath({ ...pathState, appended: plan.onPath ? true : pathAnswered });
    }

    writeSettings({
      modelsDir: models.resolved,
      backend: installed.backend,
      launcher: plan?.shim,
      installedAt: new Date().toISOString(),
    });

    view.setSummary(summarySections(installed, models, plan, pathAnswered));
    view.show("summary", installed.tag);
    await checkpoint();
  } catch (err) {
    if (!(err instanceof QuitError)) {
      view.setProgress("install failed", undefined, err instanceof Error ? err.message : String(err));
      // Give the reader a moment to read the failure before the screen goes.
      await new Promise((done) => setTimeout(done, 2500));
    }
    renderer.keyInput.off("keypress", keyHandler);
    destroyRenderer(renderer);
    return err instanceof QuitError ? 0 : 1;
  }

  renderer.keyInput.off("keypress", keyHandler);
  destroyRenderer(renderer);
  if (launch && plan) {
    const result = spawnSync(bunBinary(), [appEntry(plan.target)], { stdio: "inherit" });
    return result.status ?? 0;
  }
  return 0;
}

function readPackageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function abbreviate(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// -- plain-text path ------------------------------------------------------

async function runPlain(opts: InstallCliOptions): Promise<number> {
  const hardware = detectHardware();
  const options = assessBackends(hardware);
  const proposal = proposeBackend(hardware);
  const chosen =
    opts.backend && opts.backend !== "auto"
      ? opts.backend
      : (options.find((option) => option.recommended)?.def.id ?? proposal.backend);
  console.log(describeHardware(hardware));
  for (const warning of proposal.warnings) console.log(`warn: ${warning}`);
  console.log(`backend: ${backendLabel(chosen)} (${proposal.reasons.join("; ")})`);

  const rawModels = opts.modelsDir ?? readSettings().modelsDir ?? abbreviate(defaultModelsDir());
  const models = ensureModelsDir(inspectModelsDir(rawModels));
  if (models.error) console.log(`warn: ${models.error}`);
  else console.log(`models: ${models.resolved}${models.created ? " (created)" : ""}`);
  writeSettings({ modelsDir: models.resolved });

  const existing = opts.force ? undefined : readReceipt();
  let installed: { backend: Backend; tag: string; binary: string };
  if (existing) {
    console.log(`server: already installed at ${existing.binary} (${existing.tag}/${existing.backend})`);
    installed = { backend: existing.backend, tag: existing.tag, binary: existing.binary };
  } else {
    try {
      installed =
        chosen === "source"
          ? { backend: "cpu", tag: "source", binary: cmakeBuild("cpu") }
          : await provision(chosen, {
              tag: opts.tag,
              onProgress: (p) => {
                const pct = p.fraction !== undefined ? ` ${Math.round(p.fraction * 100)}%` : "";
                console.log(`[${p.phase}] ${p.label}${pct}`);
              },
            });
    } catch (err) {
      if (opts.noBuild) throw err;
      console.log("no prebuilt build worked, compiling from source ...");
      installed = { backend: "cpu", tag: "source", binary: cmakeBuild("cpu") };
    }
    console.log(`server: ${installed.binary} (${installed.tag}/${installed.backend})`);
  }

  if (opts.noPath) {
    console.log("path: skipped (--no-path)");
  } else {
    const plan = await planLauncher(opts);
    writeShim(plan.bin, plan.entry, bunBinary());
    if (plan.onPath) {
      console.log(`launcher: ${plan.shim} (${plan.bin} is already on PATH)`);
    } else {
      const result = opts.yes ? appendPathEntry(plan.rc, plan.bin, plan.shell) : "skipped";
      console.log(`launcher: ${plan.shim}`);
      console.log(
        result === "added"
          ? `path: appended to ${plan.rc} — open a new shell to pick it up`
          : `path: ${plan.bin} is not on PATH. Add this to ${plan.rc}:\n  ${plan.line}`,
      );
    }
    writeSettings({ launcher: plan.shim });
  }
  writeSettings({ backend: installed.backend, installedAt: new Date().toISOString() });
  console.log("");
  console.log(`drop a .gguf into ${models.resolved}, then run: lazyllama`);
  return 0;
}

// -- entry ----------------------------------------------------------------

export const INSTALL_USAGE = `lazyllama setup — the server, the models directory and the launcher

  bun run setup                   interactive wizard (this is the normal path)
  bun run setup --yes             accept every default, no prompts
  bun run setup --backend vulkan  pick a backend up front
  bun run setup --models-dir ~/llama-models
                                  where the .gguf files live (default: ~/lazyllama-models)
  bun run setup --link            point the launcher at this checkout instead of copying it
  bun run setup --no-path         install everything but leave PATH alone
  bun run setup --no-build        never fall back to compiling llama.cpp
  bun run setup --tag b11200      pin a llama.cpp release
  bun run setup --force           reinstall even if a receipt exists
  bun run setup --launch          start lazyllama when the wizard finishes

The command is "setup", not "install": a script named "install" is a package
manager lifecycle hook, so a plain "bun install" would run the wizard.
`;

export async function runInstall(opts: InstallCliOptions): Promise<number> {
  if (opts.help) {
    console.log(INSTALL_USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(readPackageVersion());
    return 0;
  }
  const interactive = opts.yes !== true && process.stdin.isTTY === true && process.stdout.isTTY === true;
  return interactive ? runWizard(opts) : runPlain(opts);
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    process.exit(await runInstall(opts));
  } catch (err) {
    console.error(`lazyllama install failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
