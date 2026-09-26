// Server provisioning logic that can run offline: where the receipt lives,
// how a binary is found in an unpacked release, and the untouched local model
// scan. The download, extract, verify and compile paths are never run here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findServerBinary, readReceipt, receiptPath, serverInstallDir } from "../src/installer.ts";
import { LAZYLLAMA_LOGO } from "../src/logo.ts";
import { defaultModelsDir, scanLocalModels } from "../src/models.ts";

let config: string;
let dataHome: string;
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "lazyllama-installer-"));
  dataHome = mkdtempSync(join(tmpdir(), "lazyllama-data-"));
  process.env["LAZYLLAMA_CONFIG_DIR"] = config;
  process.env["XDG_DATA_HOME"] = dataHome;
});
afterEach(() => {
  delete process.env["LAZYLLAMA_CONFIG_DIR"];
  delete process.env["XDG_DATA_HOME"];
  rmSync(config, { recursive: true, force: true });
  rmSync(dataHome, { recursive: true, force: true });
});

describe("install locations", () => {
  test("the receipt and the server tree live under the XDG data dir", () => {
    expect(serverInstallDir()).toBe(join(dataHome, "lazyllama", "server"));
    expect(receiptPath()).toBe(join(serverInstallDir(), ".installed.json"));
  });
});

describe("receipt", () => {
  test("is absent until something is installed", () => {
    expect(readReceipt()).toBeUndefined();
  });

  test("a receipt pointing at a missing binary is ignored", () => {
    mkdirSync(serverInstallDir(), { recursive: true });
    writeFileSync(receiptPath(), JSON.stringify({ tag: "b1", backend: "cpu", binary: "/gone/llama-server" }));
    expect(readReceipt()).toBeUndefined();
  });

  test("a receipt with a live binary reports the recorded slice", () => {
    mkdirSync(serverInstallDir(), { recursive: true });
    const binary = join(serverInstallDir(), "llama-server");
    writeFileSync(binary, "#!/bin/sh\n");
    writeFileSync(
      receiptPath(),
      JSON.stringify({
        tag: "b11200",
        backend: "vulkan",
        binary,
        arch: "x64",
        platform: "linux",
        installedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(readReceipt()).toEqual({
      tag: "b11200",
      backend: "vulkan",
      binary,
      arch: "x64",
      platform: "linux",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("a corrupt receipt is treated as no receipt", () => {
    mkdirSync(serverInstallDir(), { recursive: true });
    writeFileSync(receiptPath(), "{ truncated");
    expect(readReceipt()).toBeUndefined();
  });

  test("an older receipt without the new fields still resolves", () => {
    mkdirSync(serverInstallDir(), { recursive: true });
    const binary = join(serverInstallDir(), "llama-server");
    writeFileSync(binary, "#!/bin/sh\n");
    writeFileSync(receiptPath(), JSON.stringify({ tag: "b1", backend: "cpu", binary }));
    const receipt = readReceipt();
    expect(receipt?.binary).toBe(binary);
    expect(receipt?.arch.length).toBeGreaterThan(0);
    expect(receipt?.platform.length).toBeGreaterThan(0);
  });
});

describe("binary discovery", () => {
  test("walks a release tree to find llama-server", () => {
    const root = join(config, "release");
    mkdirSync(join(root, "build", "bin"), { recursive: true });
    writeFileSync(join(root, "build", "bin", "llama-cli"), "x");
    writeFileSync(join(root, "build", "bin", "llama-server"), "x");
    expect(findServerBinary(root)).toBe(join(root, "build", "bin", "llama-server"));
  });

  test("a missing or empty tree finds nothing instead of throwing", () => {
    expect(findServerBinary(join(config, "nope"))).toBeUndefined();
    const empty = join(config, "empty");
    mkdirSync(empty, { recursive: true });
    expect(findServerBinary(empty)).toBeUndefined();
  });
});

describe("local model scan", () => {
  test("finds gguf files, ignores the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "lazyllama-models-"));
    try {
      writeFileSync(join(dir, "qwen.gguf"), "x");
      writeFileSync(join(dir, "notes.txt"), "x");
      const found = scanLocalModels(dir);
      expect(found.map((m) => m.name)).toEqual(["qwen.gguf"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("missing dir scans empty", () => {
    expect(scanLocalModels(join(tmpdir(), "lazyllama-nope-xyz"))).toEqual([]);
  });
  test("no settings means the repo-relative models directory", () => {
    expect(defaultModelsDir()).toBe(join(process.cwd(), "models"));
  });
});

describe("logo", () => {
  test("block wordmark art is non-empty", () => {
    expect(LAZYLLAMA_LOGO).toContain("██╗");
  });
});
