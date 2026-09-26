// Backend catalog, hardware survey and release-asset selection. Every case runs
// from fixtures: no GPU, no network, no /proc.

import { describe, expect, test } from "bun:test";
import {
  ARCH_TOKEN,
  assessBackends,
  BACKEND_CATALOG,
  backendDef,
  cudaBackendForDriver,
  describeHardware,
  deviceVisible,
  detectHardware,
  fallbackChain,
  formatGiB,
  isBinaryTag,
  latestBinaryTag,
  parseCpuFlags,
  parseCpuModel,
  parseLspci,
  parseNvidiaDriverVersion,
  parseOsRelease,
  parseVulkanDevices,
  pickAsset,
  proposeBackend,
  simdSummary,
  type Backend,
  type Hardware,
  type ReleaseAsset,
} from "../src/backends.ts";

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
    cpuModel: "Test CPU",
    cores: 8,
    totalMemBytes: 32 * 1024 ** 3,
    usedMemBytes: 8 * 1024 ** 3,
    hasCmake: true,
    ...partial,
  };
}

// A real bNNNN asset listing, trimmed to the slices the catalog can ask for.
const releaseAssets: ReleaseAsset[] = [
  { name: "llama-b11200-bin-ubuntu-x64.tar.gz", url: "u/cpu-x64" },
  { name: "llama-b11200-bin-ubuntu-arm64.tar.gz", url: "u/cpu-arm64" },
  { name: "llama-b11200-bin-ubuntu-vulkan-x64.tar.gz", url: "u/vk-x64" },
  { name: "llama-b11200-bin-ubuntu-vulkan-arm64.tar.gz", url: "u/vk-arm64" },
  { name: "llama-b11200-bin-ubuntu-sycl-fp16-x64.tar.gz", url: "u/sycl16" },
  { name: "llama-b11200-bin-ubuntu-sycl-fp32-x64.tar.gz", url: "u/sycl32" },
  { name: "llama-b11200-bin-ubuntu-openvino-2026.4-x64.tar.gz", url: "u/ov" },
  { name: "llama-b11200-bin-ubuntu-rocm-10.0-x64.tar.gz", url: "u/rocm" },
  { name: "cudart-llama-b11200-bin-ubuntu-cuda-12.8-x64.tar.gz", url: "u/cu128" },
  { name: "cudart-llama-b11200-bin-ubuntu-cuda-13.4-x64.tar.gz", url: "u/cu134" },
  { name: "cudart-llama-b11200-bin-ubuntu-cuda-13.4-arm64.tar.gz", url: "u/cu134arm" },
  { name: "llama-b11200-bin-macos-arm64.tar.gz", url: "u/mac" },
  { name: "llama-b11200-bin-macos-x64.tar.gz", url: "u/mac64" },
  { name: "llama-b11200-bin-win-cpu-x64.zip", url: "u/win" },
];

const linuxX64 = { platform: "linux", arch: "x64" } as const;
const linuxArm = { platform: "linux", arch: "arm64" } as const;

describe("release tags", () => {
  test("only bNNNN tags qualify (vX.Y has no binaries)", () => {
    expect(isBinaryTag("b11163")).toBe(true);
    expect(isBinaryTag("v0.5.0")).toBe(false);
    expect(latestBinaryTag(["v0.5.0", "b11163", "b11160"])).toBe("b11163");
    expect(latestBinaryTag(["v0.5.0"])).toBeUndefined();
  });
});

describe("asset picking", () => {
  test("cpu never matches an accelerated build", () => {
    expect(pickAsset(releaseAssets, "cpu", linuxX64)?.url).toBe("u/cpu-x64");
  });
  test("every catalog slice resolves on linux x64", () => {
    const expected: Array<[Backend, string]> = [
      ["cpu", "u/cpu-x64"],
      ["vulkan", "u/vk-x64"],
      ["cuda-12.8", "u/cu128"],
      ["cuda-13.4", "u/cu134"],
      ["rocm", "u/rocm"],
      ["sycl-fp16", "u/sycl16"],
      ["sycl-fp32", "u/sycl32"],
      ["openvino", "u/ov"],
    ];
    for (const [backend, url] of expected) {
      expect(pickAsset(releaseAssets, backend, linuxX64)?.url).toBe(url);
    }
  });
  test("arm64 asks for the arm64 slice, not the x64 one", () => {
    expect(pickAsset(releaseAssets, "cpu", linuxArm)?.url).toBe("u/cpu-arm64");
    expect(pickAsset(releaseAssets, "vulkan", linuxArm)?.url).toBe("u/vk-arm64");
    expect(pickAsset(releaseAssets, "cuda-13.4", linuxArm)?.url).toBe("u/cu134arm");
  });
  test("metal resolves the macOS build for either mac arch", () => {
    expect(pickAsset(releaseAssets, "metal", { platform: "macos", arch: "arm64" })?.url).toBe("u/mac");
    expect(pickAsset(releaseAssets, "metal", { platform: "macos", arch: "x64" })?.url).toBe("u/mac64");
  });
  test("windows, source and missing slices return undefined", () => {
    expect(pickAsset(releaseAssets, "cpu", { platform: "win", arch: "x64" })).toBeUndefined();
    expect(pickAsset(releaseAssets, "source", linuxX64)).toBeUndefined();
    expect(pickAsset([], "cpu", linuxX64)).toBeUndefined();
  });
  test("arch tokens match the release naming", () => {
    expect(ARCH_TOKEN.arm64).toBe("arm64");
    expect(ARCH_TOKEN.s390x).toBe("s390x");
  });
});

describe("fallback chain", () => {
  test("starts with the choice and ends at the compiler", () => {
    const chain = fallbackChain("vulkan");
    expect(chain[0]).toBe("vulkan");
    expect(chain).toContain("cpu");
    expect(chain[chain.length - 1]).toBe("source");
  });
  test("never repeats a backend", () => {
    expect(new Set(fallbackChain("sycl-fp16")).size).toBe(fallbackChain("sycl-fp16").length);
  });
  test("device verification matches the build's own tokens", () => {
    expect(deviceVisible("cuda-12.8", "ggml_cuda: found 1 device")).toBe(true);
    expect(deviceVisible("cuda-12.8", "no devices")).toBe(false);
    expect(deviceVisible("rocm", "ggml_hip: devices ok")).toBe(true);
    expect(deviceVisible("sycl-fp16", "Level Zero: 1 device")).toBe(true);
    // CPU builds have no device list, so anything verifies.
    expect(deviceVisible("cpu", "")).toBe(true);
  });
});

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
  test("cpu model and flags", () => {
    const cpuinfo = "processor\t: 0\nmodel name\t: 12th Gen Intel(R) Core(TM) i7-1265U\nflags\t\t: fpu vme de pse\n";
    expect(parseCpuModel(cpuinfo)).toBe("12th Gen Intel(R) Core(TM) i7-1265U");
    expect(parseCpuFlags(cpuinfo)).toEqual(["fpu", "vme", "de", "pse"]);
    expect(simdSummary(hw({ cpuFlags: ["avx2", "avx512f"] }))).toBe("avx512f, avx2");
    expect(simdSummary(hw({ cpuFlags: [] }))).toBe("no known SIMD");
  });
  test("detectHardware always returns a complete survey", () => {
    const survey = detectHardware();
    expect(survey.cores).toBeGreaterThan(0);
    expect(survey.totalMemBytes).toBeGreaterThan(0);
    expect(Array.isArray(survey.gpus)).toBe(true);
  });
});

describe("backend proposal", () => {
  test("a fresh NVIDIA driver picks the newest CUDA bundle it can load", () => {
    expect(cudaBackendForDriver(570)).toBe("cuda-12.8");
    expect(cudaBackendForDriver(581)).toBe("cuda-13.4");
    expect(cudaBackendForDriver(undefined)).toBe("cuda-12.8");
    const p = proposeBackend(hw({ gpus: [{ vendor: "nvidia", name: "RTX 3070" }], nvidiaDriverMajor: 581 }));
    expect(p.backend).toBe("cuda-13.4");
    expect(p.reasons.join(" ")).toContain("581");
  });
  test("a stale NVIDIA driver warns and falls through to Vulkan", () => {
    const p = proposeBackend(
      hw({
        gpus: [{ vendor: "nvidia", name: "RTX 3070" }],
        nvidiaDriverMajor: 535,
        hasVulkanLoader: true,
        vulkanDevices: ["NVIDIA GeForce RTX 3070"],
      }),
    );
    expect(p.backend).toBe("vulkan");
    expect(p.warnings.join(" ")).toContain("535");
  });
  test("an Intel iGPU with Vulkan devices -> vulkan", () => {
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
  test("an Intel GPU without a Vulkan path -> SYCL", () => {
    const p = proposeBackend(hw({ gpus: [{ vendor: "intel", name: "Arc A770" }] }));
    expect(p.backend).toBe("sycl-fp16");
  });
  test("apple silicon -> metal", () => {
    expect(proposeBackend(hw({ prettyOs: "macOS", gpus: [{ vendor: "apple", name: "Apple M2" }] }), "macos").backend).toBe(
      "metal",
    );
  });
  test("nothing -> cpu with a simd note", () => {
    const p = proposeBackend(hw({}));
    expect(p.backend).toBe("cpu");
    expect(p.reasons.join(" ")).toContain("avx2");
  });
  test("describeHardware prints a readable survey", () => {
    const text = describeHardware(hw({ gpus: [{ vendor: "intel", name: "Iris Xe" }], hasVulkanLoader: true }));
    expect(text).toContain("GPU: [intel] Iris Xe");
    expect(text).toContain("RAM: 8.0 GiB / 32.0 GiB");
  });
  test("formatGiB hides nonsense values", () => {
    expect(formatGiB(0)).toBe("--");
    expect(formatGiB(1536 * 1024 ** 2)).toBe("1.5 GiB");
  });
});

describe("backend availability", () => {
  test("only the recommended row is marked", () => {
    const options = assessBackends(hw({ gpus: [{ vendor: "nvidia", name: "RTX 4090" }], nvidiaDriverMajor: 580 }));
    expect(options.filter((option) => option.recommended)).toHaveLength(1);
    expect(options.find((option) => option.recommended)?.def.id).toBe("cuda-13.4");
  });
  test("the recommended row comes first and available rows precede blocked ones", () => {
    const options = assessBackends(hw({ gpus: [{ vendor: "amd", name: "RX 7900 XTX" }] }));
    expect(options[0]?.recommended).toBe(true);
    const firstBlocked = options.findIndex((option) => !option.available);
    expect(firstBlocked).toBeGreaterThan(0);
    expect(options.slice(firstBlocked).every((option) => !option.available)).toBe(true);
  });
  test("blocked rows explain themselves and list no GPU as a reason", () => {
    const options = assessBackends(hw({ gpus: [{ vendor: "intel", name: "Iris Xe" }] }));
    const rocm = options.find((option) => option.def.id === "rocm");
    expect(rocm?.available).toBe(false);
    expect(rocm?.blockers.join(" ")).toContain("no AMD GPU");
    expect(rocm?.reasons).toEqual([]);
  });
  test("the driver minimum is a blocker, not a reason", () => {
    const options = assessBackends(
      hw({ gpus: [{ vendor: "nvidia", name: "RTX 3070" }], nvidiaDriverMajor: 535 }),
    );
    const cuda134 = options.find((option) => option.def.id === "cuda-13.4");
    expect(cuda134?.available).toBe(false);
    expect(cuda134?.blockers.join(" ")).toContain("driver 535 < 580");
  });
  test("source needs cmake to be offered", () => {
    expect(assessBackends(hw({})).find((o) => o.def.id === "source")?.available).toBe(true);
    expect(assessBackends(hw({ hasCmake: false })).find((o) => o.def.id === "source")?.available).toBe(false);
  });
  test("macOS only offers cpu, metal and source", () => {
    const ids = assessBackends(hw({ prettyOs: "macOS", arch: "arm64" }), "macos").map((option) => option.def.id);
    expect(ids.every((id) => id === "cpu" || id === "metal" || id === "source")).toBe(true);
  });
  test("every catalog entry declares a blurb, a size and a label", () => {
    for (const def of BACKEND_CATALOG) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.blurb.length).toBeGreaterThan(0);
      expect(def.approxMiB).toBeGreaterThanOrEqual(0);
      expect(backendDef(def.id)).toBe(def);
    }
  });
  test("every fallback points at a real backend", () => {
    const ids = new Set(BACKEND_CATALOG.map((def) => def.id));
    for (const def of BACKEND_CATALOG) {
      for (const fallback of def.fallback) expect(ids.has(fallback)).toBe(true);
    }
  });
});
