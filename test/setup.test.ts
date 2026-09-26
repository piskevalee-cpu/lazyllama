// Machine setup: settings.json, the models-directory choice, the launcher shim,
// PATH detection and the shell-rc line. Every path root is a temp directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDir,
  appEntry,
  appendPathEntry,
  binDir,
  bunBinary,
  dataHome,
  diskUsage,
  formatBytes,
  hasRuntimeDeps,
  installAppCopy,
  pathEntries,
  pathExportLine,
  pathHasDir,
  RC_MARKER,
  rcFile,
  runtimeDependencies,
  shellName,
  shimScript,
  sourceDir,
  writeShim,
} from "../src/paths.ts";
import { defaultModelsDir, expandHome, readSettings, resolveModelsDir, settingsPath, writeSettings } from "../src/settings.ts";

let home: string;
let config: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lazyllama-home-"));
  config = join(home, ".config", "lazyllama");
  mkdirSync(config, { recursive: true });
  process.env["LAZYLLAMA_CONFIG_DIR"] = config;
  delete process.env["LAZYLLAMA_MODELS_DIR"];
  delete process.env["XDG_DATA_HOME"];
  delete process.env["XDG_BIN_HOME"];
});
afterEach(() => {
  delete process.env["LAZYLLAMA_CONFIG_DIR"];
  rmSync(home, { recursive: true, force: true });
});

describe("settings.json", () => {
  test("round-trips the installer choices", () => {
    writeSettings({ modelsDir: "~/lazyllama-models", backend: "vulkan", launcher: "/home/u/.local/bin/lazyllama" });
    const settings = readSettings();
    expect(settings.modelsDir).toBe("~/lazyllama-models");
    expect(settings.backend).toBe("vulkan");
    expect(settings.launcher).toBe("/home/u/.local/bin/lazyllama");
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).modelsDir).toBe("~/lazyllama-models");
  });

  test("patches merge instead of replacing", () => {
    writeSettings({ modelsDir: "/a" });
    writeSettings({ backend: "cpu" });
    expect(readSettings()).toEqual({ modelsDir: "/a", backend: "cpu" });
  });

  test("garbage on disk degrades to no settings", () => {
    writeFileSync(settingsPath(), "not json at all");
    expect(readSettings()).toEqual({});
  });

  test("unknown keys and wrong types are dropped", () => {
    writeFileSync(settingsPath(), JSON.stringify({ modelsDir: 42, nonsense: true, backend: "vulkan" }));
    expect(readSettings()).toEqual({ backend: "vulkan" });
  });

  test("no file at all is not an error", () => {
    rmSync(settingsPath(), { force: true });
    expect(readSettings()).toEqual({});
  });
});

describe("models directory", () => {
  test("the suggested default lives in the home directory", () => {
    expect(defaultModelsDir(home)).toBe(join(home, "lazyllama-models"));
  });

  test("~ expands, relative paths resolve, absolute paths survive", () => {
    expect(expandHome("~/models", home)).toBe(join(home, "models"));
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("/srv/models", home)).toBe("/srv/models");
    expect(expandHome("models", home)).toBe(join(process.cwd(), "models"));
    expect(expandHome("", home)).toBe("");
  });

  test("precedence is env, then settings, then ./models", () => {
    const cwd = process.cwd();
    expect(resolveModelsDir(cwd, home)).toBe(join(cwd, "models"));
    writeSettings({ modelsDir: "~/lazyllama-models" });
    expect(resolveModelsDir(cwd, home)).toBe(join(home, "lazyllama-models"));
    process.env["LAZYLLAMA_MODELS_DIR"] = "/mnt/big";
    expect(resolveModelsDir(cwd, home)).toBe("/mnt/big");
  });
});

describe("xdg roots", () => {
  test("defaults follow the XDG spec, overrides win", () => {
    expect(dataHome({}, home)).toBe(join(home, ".local", "share"));
    expect(binDir({}, home)).toBe(join(home, ".local", "bin"));
    expect(dataHome({ XDG_DATA_HOME: "/data" }, home)).toBe("/data");
    expect(binDir({ XDG_BIN_HOME: "/bin" }, home)).toBe("/bin");
  });

  test("the app copy and the llama.cpp checkout sit under the data dir", () => {
    expect(appDir({}, home)).toBe(join(home, ".local", "share", "lazyllama", "app"));
    expect(sourceDir({}, home)).toBe(join(home, ".local", "share", "lazyllama", "llama.cpp"));
    expect(appEntry("/opt/ll")).toBe(join("/opt/ll", "src", "index.ts"));
  });
});

describe("launcher shim", () => {
  test("is a POSIX script that execs bun with the entry and all arguments", () => {
    const script = shimScript("/opt/lazyllama/src/index.ts");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`exec "$BUN" '/opt/lazyllama/src/index.ts' "$@"`);
    expect(script).toContain("${LAZYLLAMA_BUN:-bun}");
  });

  test("quotes paths that would otherwise break the shell", () => {
    const script = shimScript("/home/o'brien/my models/src/index.ts");
    expect(script).toContain(`'\\''`);
    expect(script).not.toContain("\nmy models");
  });

  test("bakes in an absolute bun when one is given", () => {
    expect(shimScript("/a/index.ts", "/home/u/.bun/bin/bun")).toContain("${LAZYLLAMA_BUN:-/home/u/.bun/bin/bun}");
  });

  test("writing it is idempotent and executable", () => {
    const bin = join(home, ".local", "bin");
    const first = writeShim(bin, "/a/src/index.ts", "/usr/bin/bun");
    writeShim(bin, "/b/src/index.ts", "/usr/bin/bun");
    const second = writeShim(bin, "/b/src/index.ts", "/usr/bin/bun");
    expect(first).toBe(second);
    expect(first).toBe(join(bin, "lazyllama"));
    expect(readFileSync(first, "utf8")).toContain("'/b/src/index.ts'");
    // eslint-disable-next-line no-bitwise
    expect(statSync(first).mode & 0o111).toBeGreaterThan(0);
  });

  test("bunBinary prefers a bun on PATH and falls back to this process", () => {
    const fake = join(home, "fakebin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "bun"), "#!/bin/sh\n");
    chmodSync(join(fake, "bun"), 0o755);
    expect(bunBinary({ PATH: fake }, "/usr/bin/node")).toBe(join(fake, "bun"));
    expect(bunBinary({ PATH: "" }, "/home/u/.bun/bin/bun")).toBe("/home/u/.bun/bin/bun");
    expect(bunBinary({ PATH: "" }, "/usr/bin/node")).toBe("bun");
  });
});

describe("PATH handling", () => {
  test("detects a directory on PATH, and compares resolved paths", () => {
    const bin = join(home, ".local", "bin");
    expect(pathHasDir(bin, { PATH: `/usr/bin:${bin}:/bin` })).toBe(true);
    expect(pathHasDir(bin, { PATH: "/usr/bin" })).toBe(false);
    expect(pathHasDir(bin, { PATH: "" })).toBe(false);
    expect(pathHasDir(`${bin}/.`, { PATH: bin })).toBe(true);
  });

  test("splits entries on the platform delimiter", () => {
    expect(pathEntries({ PATH: "/a::/b" })).toEqual(["/a", "/b"]);
  });

  test("knows which rc file each shell reads", () => {
    expect(shellName({ SHELL: "/bin/zsh" })).toBe("zsh");
    expect(shellName({ SHELL: "/usr/bin/fish" })).toBe("fish");
    expect(shellName({ SHELL: "/bin/sh" })).toBe("sh");
    expect(shellName({ SHELL: "/bin/tcsh" })).toBe("unknown");
    expect(shellName({})).toBe("unknown");
    expect(rcFile("zsh", home)).toBe(join(home, ".zshrc"));
    expect(rcFile("bash", home)).toBe(join(home, ".bashrc"));
    expect(rcFile("unknown", home)).toBe(join(home, ".bashrc"));
    expect(rcFile("fish", home)).toBe(join(home, ".config", "fish", "config.fish"));
  });

  test("quotes the line it prints, in the shell's own syntax", () => {
    expect(pathExportLine("/home/u/my bin", "bash")).toBe(`export PATH='/home/u/my bin:$PATH'`);
    expect(pathExportLine("/home/u/my bin", "fish")).toBe(`set -gx PATH '/home/u/my bin' $PATH`);
  });

  test("appends once, guarded by a marker", () => {
    const rc = join(home, ".bashrc");
    writeFileSync(rc, "export EDITOR=vim\n");
    expect(appendPathEntry(rc, "/home/u/.local/bin", "bash")).toBe("added");
    const once = readFileSync(rc, "utf8");
    expect(once).toContain("export EDITOR=vim\n");
    expect(once).toContain(RC_MARKER);
    expect(once.endsWith("\n")).toBe(true);
    expect(appendPathEntry(rc, "/home/u/.local/bin", "bash")).toBe("already-present");
    expect(readFileSync(rc, "utf8")).toBe(once);
  });

  test("handles a missing rc file and one without a trailing newline", () => {
    const fresh = join(home, ".zshrc");
    expect(appendPathEntry(fresh, "/bin", "zsh")).toBe("added");
    const bare = join(home, ".profile");
    writeFileSync(bare, "export X=1");
    appendPathEntry(bare, "/bin", "sh");
    expect(readFileSync(bare, "utf8")).toBe(`export X=1\n${RC_MARKER}\nexport PATH='/bin:$PATH'\n`);
  });

  test("reports failure instead of throwing when the rc cannot be created", () => {
    // A file where the rc's directory should be: mkdir cannot win.
    writeFileSync(join(home, "in-the-way"), "x");
    expect(appendPathEntry(join(home, "in-the-way", "rc"), "/bin", "bash")).toBe("failed");
  });
});

describe("disk space", () => {
  test("reads real free space for a directory that exists", () => {
    const usage = diskUsage(home);
    expect(usage).toBeDefined();
    expect(usage?.totalBytes).toBeGreaterThan(0);
    expect(usage?.freeBytes).toBeGreaterThan(0);
    expect(usage?.usedFraction).toBeGreaterThanOrEqual(0);
    expect(usage?.usedFraction).toBeLessThanOrEqual(1);
  });

  test("a missing path is undefined, not a throw", () => {
    expect(diskUsage(join(home, "nope", "deeper"))).toBeUndefined();
  });

  test("formats byte counts the way the wizard shows them", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(30 * 1024 ** 2)).toBe("30 MiB");
    expect(formatBytes(136 * 1024 ** 3)).toBe("136 GiB");
  });
});

describe("standalone app copy", () => {
  test("resolves the runtime dependency closure and drops type-only peers", () => {
    const closure = runtimeDependencies(process.cwd(), ["@opentui/core"]);
    expect(closure).toContain("@opentui/core");
    // The prebuilt native binary for this platform has to travel with it.
    expect(closure.some((name) => name.startsWith("@opentui/core-linux"))).toBe(true);
    // Typescript is a type-only peer of web-tree-sitter and is never imported.
    expect(closure).not.toContain("typescript");
    // A name that is not installed is skipped, never invented.
    expect(runtimeDependencies(process.cwd(), ["@opentui/core", "nope-not-real"])).not.toContain("nope-not-real");
  });

  test("copies the app and its dependencies, so the copy runs on its own", async () => {
    const target = join(home, "app");
    const progress: string[] = [];
    const result = await installAppCopy(process.cwd(), target, (label) => progress.push(label));
    expect(progress[0]).toBe("copying src");
    expect(progress.at(-1)).toBe("launcher ready");
    expect(result.depsReady).toBe(true);
    // Sources and manifests travel; tests and docs do not.
    expect(result.entry).toBe(join(target, "src", "index.ts"));
    for (const file of ["src/index.ts", "src/install.ts", "package.json", "bun.lock", "tsconfig.json"]) {
      expect(() => statSync(join(target, file))).not.toThrow();
    }
    expect(() => statSync(join(target, "test"))).toThrow();
    expect(hasRuntimeDeps(target)).toBe(true);
  });

  test("hasRuntimeDeps is false for a bare directory", () => {
    const bare = join(home, "bare");
    mkdirSync(bare, { recursive: true });
    expect(hasRuntimeDeps(bare)).toBe(false);
  });
});
