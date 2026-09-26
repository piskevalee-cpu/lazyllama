// GPU memory detection. Every parser runs from fixture text, so the suite needs
// no GPU and no vendor tools: a machine without one is the normal case.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNvidiaSmi, parseRocmSmi, readDrmCards, readDrmMemory, resetGpuMemoryCache, sampleGpuMemory, vendorFromPciId } from "../src/vram.ts";
import { formatGpuRows } from "../src/ui/sidebar.ts";
import { formatGiB } from "../src/ascii.ts";
import { vramRows } from "../src/ui/installView.ts";

const GIB = 1024 ** 3;

afterEach(() => {
  resetGpuMemoryCache();
});

describe("nvidia-smi parsing", () => {
  test("one device per row, mebibytes converted to bytes", () => {
    const devices = parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282, 812\n");
    expect(devices).toEqual([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 4070",
        totalBytes: 12282 * 1024 * 1024,
        usedBytes: 812 * 1024 * 1024,
        shared: false,
      },
    ]);
  });

  test("a second card becomes a second device", () => {
    const devices = parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282, 812\nNVIDIA GeForce RTX 3060, 12288, 0\n");
    expect(devices).toHaveLength(2);
    expect(devices[1]?.name).toContain("3060");
    expect(devices[1]?.usedBytes).toBe(0);
  });

  test("headers, [N/A] rows and junk are skipped, a device without a counter is kept", () => {
    const devices = parseNvidiaSmi(
      "name, memory.total [MiB], memory.used [MiB]\n" +
        "NVIDIA A100-SXM4-40GB, 40960, 1024\n" +
        "NVIDIA T400, N/A, N/A\n" +
        "\n" +
        "not a row\n",
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]?.name).toContain("A100");
    expect(devices[0]?.totalBytes).toBe(40 * GIB);
  });

  test("an absent counter stays unknown rather than becoming zero", () => {
    const devices = parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282\n");
    expect(devices[0]?.usedBytes).toBeUndefined();
    expect(devices[0]?.totalBytes).toBeGreaterThan(0);
  });
});

describe("rocm-smi parsing", () => {
  const CSV = [
    "device, VRAM Total Memory (B), VRAM Total Used Memory (B)",
    "GPU[0] : Card series : AMD Radeon RX 7900 XTX",
    "GPU[0] : Card model : 0x744c",
    "GPU[0] : VRAM Total Memory (B) : 25753026560",
    "GPU[0] : VRAM Total Used Memory (B) : 1073741824",
    "GPU[1] : Card series : AMD Radeon RX 7600",
    "GPU[1] : VRAM Total Memory (B) : 8589934592",
  ].join("\n");

  test("groups rows per device and keeps the series name", () => {
    const devices = parseRocmSmi(CSV);
    expect(devices).toHaveLength(2);
    expect(devices[0]?.name).toBe("AMD Radeon RX 7900 XTX");
    expect(devices[0]?.totalBytes).toBe(25753026560);
    expect(devices[0]?.usedBytes).toBe(1073741824);
    expect(devices[0]?.vendor).toBe("amd");
  });

  test("the card model is a PCI id and never replaces the series name", () => {
    const devices = parseRocmSmi("GPU[0] : Card series : AMD Radeon RX 7900 XTX\nGPU[0] : Card model : 0x744c\nGPU[0] : VRAM Total Memory (B) : 1024");
    expect(devices[0]?.name).toBe("AMD Radeon RX 7900 XTX");
  });

  test("a device with no counter or no total is dropped", () => {
    expect(parseRocmSmi("GPU[0] : VRAM Total Memory (B) : 0")).toEqual([]);
    expect(parseRocmSmi("")).toEqual([]);
  });
});

describe("sysfs cards", () => {
  test("a card without mem_info_vram_total has no dedicated pool", () => {
    const root = mkdtempSync(join(tmpdir(), "lazyllama-drm-"));
    try {
      const device = join(root, "card0", "device");
      mkdirSync(device, { recursive: true });
      writeFileSync(join(device, "vendor"), "0x1002\n");
      const card = readDrmCards(root)[0];
      expect(card?.vendor).toBe("amd");
      expect(readDrmMemory(card!)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hex counters become a device with a live used value", () => {
    const root = mkdtempSync(join(tmpdir(), "lazyllama-drm-"));
    try {
      const device = join(root, "card1", "device");
      mkdirSync(device, { recursive: true });
      writeFileSync(join(device, "vendor"), "0x8086\n");
      writeFileSync(join(device, "mem_info_vram_total"), "14000000000\n");
      writeFileSync(join(device, "mem_info_vram_used"), "200000000\n");
      const cards = readDrmCards(root, "00:02.0 VGA compatible controller [0300]: Intel Corporation DG2 [8086:5697]");
      expect(cards).toHaveLength(1);
      const memory = readDrmMemory(cards[0]!);
      expect(memory?.vendor).toBe("intel");
      expect(memory?.name).toContain("DG2");
      expect(memory?.totalBytes).toBe(0x14000000000);
      expect(memory?.usedBytes).toBe(0x200000000);
      expect(memory?.shared).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("connectors, render nodes and missing sysfs are ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "lazyllama-drm-"));
    try {
      mkdirSync(join(root, "card0-DP-1"), { recursive: true });
      mkdirSync(join(root, "renderD128"), { recursive: true });
      expect(readDrmCards(root)).toEqual([]);
      expect(readDrmCards(join(root, "nope"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pci vendor ids map to the vendors the panel shows", () => {
    expect(vendorFromPciId("0x10de")).toBe("nvidia");
    expect(vendorFromPciId("0x1002")).toBe("amd");
    expect(vendorFromPciId("0x8086")).toBe("intel");
    expect(vendorFromPciId("0x1234")).toBe("other");
  });
});

describe("sampling on a machine with no gpu", () => {
  test("reports an empty list rather than throwing", () => {
    // The test machine has no vendor tools, which is the case that matters:
    // the panel must stay quiet instead of showing an empty GPU block.
    expect(sampleGpuMemory()).toEqual([]);
  });
});

describe("gpu panel rows", () => {
  test("no devices means no rows, so the section hides itself", () => {
    expect(formatGpuRows([])).toEqual([]);
    expect(vramRows([])).toEqual([]);
  });

  test("a dedicated card gets a name, a meter and a used/total line", () => {
    const rows = formatGpuRows([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 4070",
        totalBytes: 12 * GIB,
        usedBytes: 8 * GIB,
        shared: false,
      },
    ]);
    expect(rows.map((row) => row.label)).toEqual(["gpu", "vram", "used"]);
    expect(rows[0]?.value).toBe("NVIDIA GeForce RTX 4070");
    expect(rows[1]?.bar).toBeCloseTo(0.667, 2);
    expect(rows[1]?.value).toBe("67%");
    expect(rows[2]?.value).toBe("8.0 / 12 GiB");
  });

  test("an unknown counter hides the meter instead of claiming zero", () => {
    const rows = formatGpuRows([
      { vendor: "amd", name: "AMD Radeon RX 7900 XTX", totalBytes: 24 * GIB, usedBytes: undefined, shared: false },
    ]);
    expect(rows[1]?.bar).toBeUndefined();
    expect(rows[1]?.value).toBe("--");
    expect(rows[1]?.tone).toBe("muted");
    expect(rows[2]?.value).toBe("? / 24 GiB");
  });

  test("a second device gets its own rows, numbered", () => {
    const rows = formatGpuRows([
      { vendor: "nvidia", name: "A", totalBytes: 8 * GIB, usedBytes: 1 * GIB, shared: false },
      { vendor: "nvidia", name: "B", totalBytes: 8 * GIB, usedBytes: 2 * GIB, shared: false },
    ]);
    expect(rows.map((row) => row.label)).toEqual(["gpu", "vram", "used", "gpu2", "vram", "used"]);
  });

  test("shared memory says so, with no meter to lie with", () => {
    const rows = formatGpuRows([
      { vendor: "apple", name: "Apple Silicon (Metal)", totalBytes: 64 * GIB, usedBytes: undefined, shared: true },
    ]);
    expect(rows[1]?.value).toBe("shared");
    expect(rows[1]?.tone).toBe("muted");
    expect(rows[1]?.bar).toBeUndefined();
    expect(rows[2]?.value).toBe("64 GiB system");
  });

  test("an idle card reads 0, not unknown", () => {
    const rows = formatGpuRows([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 3060", totalBytes: 12 * GIB, usedBytes: 0, shared: false },
    ]);
    expect(rows[1]?.value).toBe("0%");
    expect(rows[2]?.value).toBe("0.0 / 12 GiB");
  });

  test("gib formatting is honest about nonsense", () => {
    expect(formatGiB(12 * GIB)).toBe("12 GiB");
    expect(formatGiB(1.5 * GIB)).toBe("1.5 GiB");
    expect(formatGiB(0)).toBe("0.0 GiB");
    expect(formatGiB(-1)).toBe("--");
    expect(formatGiB(Number.NaN)).toBe("--");
  });
});

describe("installer survey rows", () => {
  test("a dedicated card becomes one metered vram row", () => {
    const rows = vramRows([
      { vendor: "nvidia", name: "RTX 4070", totalBytes: 12 * GIB, usedBytes: 3 * GIB, shared: false },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("vram");
    expect(rows[0]?.value).toBe("3.0 / 12 GiB");
    expect(rows[0]?.bar).toBeCloseTo(0.25);
  });

  test("two cards get numbered rows, shared memory is muted", () => {
    const rows = vramRows([
      { vendor: "nvidia", name: "A", totalBytes: 8 * GIB, usedBytes: 1 * GIB, shared: false },
      { vendor: "amd", name: "B", totalBytes: 24 * GIB, usedBytes: undefined, shared: false },
      { vendor: "apple", name: "C", totalBytes: 64 * GIB, usedBytes: undefined, shared: true },
    ]);
    expect(rows.map((row) => row.label)).toEqual(["vram1", "vram2", "vram3"]);
    expect(rows[2]?.value).toContain("shared");
    expect(rows[2]?.tone).toBe("muted");
  });
});
