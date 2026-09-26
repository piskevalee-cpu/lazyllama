// Installer + model-scan tests. Network-touching paths (fetchReleases,
// downloads, cmake) are NOT tested here; only pure selection logic.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeHardware,
  isBinaryTag,
  latestBinaryTag,
  parseLspci,
  parseNvidiaDriverVersion,
  parseOsRelease,
  parseVulkanDevices,
  pickAsset,
  proposeBackend,
  type Hardware,
  type ReleaseAsset,
} from "../src/installer.ts";
import { scanLocalModels } from "../src/models.ts";
import { LAZYLLAMA_LOGO } from "../src/logo.ts";

const assets: ReleaseAsset[] = [
  { name: "llama-b11163-bin-ubuntu-x64.tar.gz", url: "https://x/cpu" },
  { name: "llama-b11163-bin-ubuntu-vulkan-x64.tar.gz", url: "https://x/vk" },
  { name: "cudart-llama-b11163-bin-ubuntu-cuda-12.8-x64.tar.gz", url: "https://x/cu" },
  { name: "llama-b11163-bin-ubuntu-rocm-10.0-x64.tar.gz", url: "https://x/rocm" },
  { name: "llama-b11163-bin-win-cpu-x64.zip", url: "https://x/win" },
];

describe("release tags", () => {
  test("only bNNNN tags qualify (vX.Y has no binaries)", () => {
    expect(isBinaryTag("b11163")).toBe(true);
    expect(isBinaryTag("v0.5.0")).toBe(false);
    expect(latestBinaryTag(["v0.5.0", "b11163", "b11160"])).toBe("b11163");
    expect(latestBinaryTag(["v0.5.0"])).toBeUndefined();
  });
});

describe("asset picking", () => {
  test("cpu skips gpu/spiced variants", () => {
    expect(pickAsset(assets, "cpu")?.url).toBe("https://x/cpu");
  });
  test("vulkan and cuda resolve", () => {
    expect(pickAsset(assets, "vulkan")?.url).toBe("https://x/vk");
    expect(pickAsset(assets, "cuda")?.url).toBe("https://x/cu");
  });
  test("missing backend returns undefined", () => {
    expect(pickAsset([], "cpu")).toBeUndefined();
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
});

describe("logo", () => {
  test("block wordmark art is non-empty", () => {
    expect(LAZYLLAMA_LOGO).toContain("██╗");
  });
});

const INTEL_LSPCI =
  "00:02.0 VGA compatible controller [0300]: Intel Corporation Alder Lake-UP3 GT2 [Iris Xe Graphics] [8086:46a8] (rev 0c)";
const NVIDIA_LSPCI =
  "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA104 [GeForce RTX 3070] [10de:2484] (rev a1)";
const AMD_LSPCI =
  "03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX] [1002:744c] (rev c8)";

function hw(partial: Partial<Hardware>): Hardware {
  return {
    prettyOs: "Arch Linux",
    arch: "x64",
    gpus: [],
    hasVulkanLoader: false,
    vulkanDevices: [],
    cpuFlags: ["avx2"],
    ...partial,
  };
}

describe("hardware parsers", () => {
  test("os-release pretty name", () => {
    expect(parseOsRelease('NAME="Omarchy"\nPRETTY_NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\n')).toBe("Omarchy");
  });
  test("lspci vendor ids", () => {
    expect(parseLspci(INTEL_LSPCI)).toEqual([{ vendor: "intel", name: expect.stringContaining("Iris Xe") }]);
    expect(parseLspci(`${NVIDIA_LSPCI}\n${AMD_LSPCI}`).map((g) => g.vendor)).toEqual(["nvidia", "amd"]);
    expect(parseLspci("00:1f.3 Audio device [0403]: Intel [8086:51c8]")).toEqual([]);
  });
  test("nvidia driver major", () => {
    expect(parseNvidiaDriverVersion("565.57.01\n")).toBe(565);
    expect(parseNvidiaDriverVersion("")).toBeUndefined();
  });
  test("vulkan device names", () => {
    expect(parseVulkanDevices("\tdeviceName         = Intel(R) Iris(R) Xe Graphics (ADL GT2)\n")).toEqual([
      "Intel(R) Iris(R) Xe Graphics (ADL GT2)",
    ]);
  });
});

describe("backend proposal", () => {
  test("fresh nvidia driver -> cuda", () => {
    const p = proposeBackend(hw({ gpus: [{ vendor: "nvidia", name: "RTX 3070" }], nvidiaDriverMajor: 570 }));
    expect(p.backend).toBe("cuda");
  });
  test("stale nvidia driver warns and falls through", () => {
    const p = proposeBackend(hw({ gpus: [{ vendor: "nvidia", name: "RTX 3070" }], nvidiaDriverMajor: 535 }));
    expect(p.backend).toBe("cpu");
    expect(p.warnings.join(" ")).toContain("535");
  });
  test("intel igpu with vulkan devices -> vulkan", () => {
    const p = proposeBackend(
      hw({
        gpus: [{ vendor: "intel", name: "Iris Xe" }],
        hasVulkanLoader: true,
        vulkanDevices: ["Intel(R) Iris(R) Xe Graphics (ADL GT2)"],
      }),
    );
    expect(p.backend).toBe("vulkan");
    expect(p.reasons.join(" ")).toContain("Iris");
  });
  test("amd discrete without enumerated devices but loader present -> vulkan", () => {
    const p = proposeBackend(hw({ gpus: [{ vendor: "amd", name: "RX 7900 XTX" }], hasVulkanLoader: true }));
    expect(p.backend).toBe("vulkan");
  });
  test("apple silicon -> cpu build (metal included)", () => {
    const p = proposeBackend(hw({ prettyOs: "macOS", gpus: [{ vendor: "apple", name: "Apple Silicon (Metal)" }] }));
    expect(p.backend).toBe("cpu");
  });
  test("nothing -> cpu with simd note", () => {
    const p = proposeBackend(hw({}));
    expect(p.backend).toBe("cpu");
    expect(p.reasons.join(" ")).toContain("avx2");
  });
  test("describeHardware prints a readable survey", () => {
    const s = describeHardware(hw({ gpus: [{ vendor: "intel", name: "Iris Xe" }], hasVulkanLoader: true }));
    expect(s).toContain("GPU: [intel] Iris Xe");
  });
});
