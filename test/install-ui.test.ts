// The `bun run install` wizard, driven through @opentui/core/testing rather
// than a real TTY. Covers the flow a person actually sees: survey, backend
// pick with the recommendation marked, a live models-directory readout, the
// download bar, the PATH question, and the summary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { assessBackends, type BackendOption, type Hardware } from "../src/backends.ts";
import { splashFrame } from "../src/splash.ts";
import { InstallView, backendRow, hardwareRows, installHints } from "../src/ui/installView.ts";
import { meterTokens } from "../src/ui/meter.ts";
import { DARK_THEME } from "../src/ui/theme.ts";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "lazyllama-install-"));
  process.env["LAZYLLAMA_CONFIG_DIR"] = configDir;
});
afterEach(() => {
  delete process.env["LAZYLLAMA_CONFIG_DIR"];
  rmSync(configDir, { recursive: true, force: true });
});

const survey: Hardware = {
  prettyOs: "Omarchy",
  arch: "x64",
  gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4070" }],
  nvidiaDriverMajor: 581,
  hasVulkanLoader: true,
  vulkanDevices: ["NVIDIA GeForce RTX 4070"],
  cpuFlags: ["avx2"],
  cpuModel: "AMD Ryzen 9 7950X",
  cores: 32,
  totalMemBytes: 64 * 1024 ** 3,
  usedMemBytes: 16 * 1024 ** 3,
  hasCmake: true,
};

const intelSurvey: Hardware = { ...survey, gpus: [{ vendor: "intel", name: "Iris Xe" }], nvidiaDriverMajor: undefined };

interface Wizard {
  view: InstallView;
  events: { picked: string[]; submitted: string[]; path: boolean[]; quit: number };
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"];
  frame(): Promise<string>;
  render(): Promise<void>;
  destroy(): void;
}

async function createWizard(width = 100, height = 40): Promise<Wizard> {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  const events = { picked: [] as string[], submitted: [] as string[], path: [] as boolean[], quit: 0 };
  const view = new InstallView(
    setup.renderer,
    {
      onBackendPick: (id) => events.picked.push(id),
      onModelsDirInput: () => {},
      onModelsDirSubmit: (raw) => events.submitted.push(raw),
      onPathAnswer: (append) => events.path.push(append),
      onAdvance: () => {},
      onLaunch: () => {},
      onCancelInstall: () => {},
      onRescan: () => {},
      onBack: () => {},
      onQuit: () => {
        events.quit += 1;
      },
    },
    DARK_THEME,
  );
  // The wizard relies on one global keypress handler, exactly like the app.
  setup.renderer.keyInput.on("keypress", (key) => view.handleKey(key));
  return {
    view,
    events,
    mockInput: setup.mockInput,
    async frame() {
      for (let i = 0; i < 3; i += 1) await setup.renderOnce();
      return setup.captureCharFrame();
    },
    async render() {
      await setup.flush();
      for (let i = 0; i < 3; i += 1) await setup.renderOnce();
    },
    destroy() {
      setup.renderer.destroy();
    },
  };
}

describe("wizard rows", () => {
  test("the hardware survey reports what the machine has, with a RAM meter", () => {
    const rows = hardwareRows(survey);
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get("os")?.value).toBe("Omarchy (x64)");
    expect(byLabel.get("cpu")?.value).toBe("AMD Ryzen 9 7950X");
    expect(byLabel.get("threads")?.value).toContain("avx2");
    expect(byLabel.get("gpu")?.value).toContain("RTX 4070");
    expect(byLabel.get("driver")?.value).toBe("nvidia 581");
    expect(byLabel.get("vulkan")?.value).toContain("RTX 4070");
    expect(byLabel.get("ram")?.value).toBe("16 / 64 GiB");
    expect(byLabel.get("ram")?.bar).toBeCloseTo(0.25);
  });

  test("a machine with no GPU says so instead of leaving a blank", () => {
    const rows = hardwareRows({
      ...survey,
      gpus: [],
      nvidiaDriverMajor: undefined,
      hasVulkanLoader: false,
      vulkanDevices: [],
    });
    const gpu = rows.find((row) => row.label === "gpu");
    expect(gpu?.value).toBe("none detected");
    expect(gpu?.tone).toBe("muted");
    expect(rows.find((row) => row.label === "vulkan")?.value).toBe("no loader");
    expect(rows.some((row) => row.label === "driver")).toBe(false);
  });

  test("the recommended backend is marked and blocked ones state the reason", () => {
    const options = assessBackends(intelSurvey);
    const rocm = options.find((option) => option.def.id === "rocm") as BackendOption;
    const vulkan = options.find((option) => option.recommended) as BackendOption;
    expect(backendRow(vulkan)).toBe("▸ Vulkan · one path for AMD, Intel and NVIDIA GPUs");
    expect(backendRow(rocm)).toBe("  ROCm 10.0 · no AMD GPU detected");
  });

  test("footer hints shorten before they can overlap the step counter", () => {
    const meta = "2/6 backend · vulkan";
    expect(installHints(100, "backend", meta)).toContain("↑/↓ pick");
    const narrow = installHints(40, "backend", meta);
    expect(narrow.length + meta.length).toBeLessThanOrEqual(40 - 4);
    expect(installHints(20, "backend", meta)).toBe("");
    expect(installHints(100, "summary", "6/6 ready")).toContain("enter start lazyllama");
  });
});

describe("wizard screens", () => {
  test("the survey step shows the machine and counts itself", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setSteps(["hardware", "backend", "models", "install", "path", "summary"]);
      wizard.view.setHardware(hardwareRows(survey));
      wizard.view.show("hardware", "cuda-13.4");
      const frame = await wizard.frame();
      expect(frame).toContain("detected hardware");
      expect(frame).toContain("AMD Ryzen 9 7950X");
      expect(frame).toContain("1/6 hardware");
      expect(frame).toContain("enter continue");
    } finally {
      wizard.destroy();
    }
  });

  test("the backend step lists every slice, marks the recommendation and explains it", async () => {
    const wizard = await createWizard();
    try {
      const options = assessBackends(survey);
      wizard.view.setBackends(options, "cuda-13.4");
      wizard.view.show("backend", "CUDA 13.4");
      const frame = await wizard.frame();
      expect(frame).toContain("▸ CUDA 13.4");
      expect(frame).toContain("Vulkan");
      expect(frame).toContain("Build from source");
      // The highlighted row's detail explains the pick and the fallback order.
      expect(frame).toContain("nvidia driver >= 580");
      expect(frame).toContain("~590 MiB");
      expect(frame).toContain("2/6 backend");
    } finally {
      wizard.destroy();
    }
  });

  test("picking a backend reports the id, and arrows move the selection", async () => {
    const wizard = await createWizard();
    try {
      const options = assessBackends(survey);
      wizard.view.setBackends(options, "cuda-13.4");
      wizard.view.show("backend", "CUDA 13.4");
      await wizard.render();
      await wizard.mockInput.pressArrow("down");
      await wizard.render();
      await wizard.mockInput.pressEnter();
      expect(wizard.events.picked).toHaveLength(1);
      expect(wizard.events.picked[0]).not.toBe("cuda-13.4");
    } finally {
      wizard.destroy();
    }
  });

  test("the models step prefills ~/lazyllama-models and reports the real directory", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setModelsDir({
        raw: "~/lazyllama-models",
        resolved: "/home/tester/lazyllama-models",
        exists: true,
        writable: true,
        freeBytes: 136 * 1024 ** 3,
        usedFraction: 0.42,
        ggufCount: 0,
      });
      wizard.view.show("models", "found");
      const frame = await wizard.frame();
      expect(frame).toContain("models directory");
      expect(frame).toContain("~/lazyllama-models");
      expect(frame).toContain("already there, writable");
      expect(frame).toContain("136 GiB free");
      expect(frame).toContain("no .gguf files yet");
      expect(frame).toContain("3/6 models");
    } finally {
      wizard.destroy();
    }
  });

  test("the install step shows a determinate bar and byte counts", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setProgress("downloading llama-b11200-bin-ubuntu-vulkan-x64.tar.gz", 0.42, "12.6 MiB / 30.0 MiB · 42%");
      wizard.view.show("install", "Vulkan");
      const frame = await wizard.frame();
      expect(frame).toContain("installing");
      expect(frame).toContain("12.6 MiB / 30.0 MiB · 42%");
      expect(frame).toContain("█");
      expect(frame).toContain("░");
      expect(frame).toContain("4/6 install");
      expect(frame).toContain("esc cancel the download");
    } finally {
      wizard.destroy();
    }
  });

  test("an unknown total keeps the bar sweeping instead of faking a percentage", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setProgress("cloning llama.cpp", undefined, "");
      wizard.view.show("install", "source");
      const frame = await wizard.frame();
      expect(frame).toContain("cloning llama.cpp");
      expect(frame).not.toContain("%");
    } finally {
      wizard.destroy();
    }
  });

  test("the PATH step shows the exact line and defaults to appending it", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setPath({
        shim: "/home/tester/.local/bin/lazyllama",
        binDir: "/home/tester/.local/bin",
        onPath: false,
        shell: "bash",
        rc: "/home/tester/.bashrc",
        line: "export PATH='/home/tester/.local/bin:$PATH'",
      });
      wizard.view.show("path", "not on PATH");
      const frame = await wizard.frame();
      expect(frame).toContain("add lazyllama to your PATH");
      expect(frame).toContain("export PATH='/home/tester/.local/bin:$PATH'");
      expect(frame).toContain("▸ append it to /home/tester/.bashrc");
      expect(frame).toContain("no thanks, I will do it myself");
      expect(frame).toContain("5/6 path");
    } finally {
      wizard.destroy();
    }
  });

  test("the summary groups what was installed, and the PATH step leaves the counter", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setSteps(["hardware", "backend", "models", "install", "summary"]);
      wizard.view.setSummary([
        {
          title: "server",
          rows: [
            { label: "backend", value: "Vulkan (b11200)" },
            { label: "binary", value: "/data/lazyllama/server/b11200/bin/llama-server" },
          ],
        },
        { title: "models", rows: [{ label: "directory", value: "/home/tester/lazyllama-models" }] },
      ]);
      wizard.view.show("summary", "b11200");
      const frame = await wizard.frame();
      expect(frame).toContain("ready");
      expect(frame).toContain("Vulkan (b11200)");
      expect(frame).toContain("lazyllama-models");
      expect(frame).toContain("5/5 ready");
    } finally {
      wizard.destroy();
    }
  });

  test("Enter in the models step commits the typed directory", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setModelsDir({
        raw: "~/lazyllama-models",
        resolved: "/home/tester/lazyllama-models",
        exists: true,
        writable: true,
        ggufCount: 2,
      });
      wizard.view.show("models", "found");
      await wizard.render();
      await wizard.mockInput.pressEnter();
      expect(wizard.events.submitted).toEqual(["~/lazyllama-models"]);
    } finally {
      wizard.destroy();
    }
  });

  test("only the visible step is mounted, and the splash owns the screen alone", async () => {
    const wizard = await createWizard();
    try {
      wizard.view.setHardware(hardwareRows(survey));
      wizard.view.show("hardware", "vulkan");
      await wizard.render();
      const frame = await wizard.frame();
      expect(frame).not.toContain("backend");
      expect(frame).not.toContain("installing");
      wizard.view.show("splash");
      // The splash paints from a frame, exactly like the app's timer drives it.
      wizard.view.renderSplash(splashFrame(400, DARK_THEME.primary, meterTokens(DARK_THEME)));
      await wizard.render();
      const splash = await wizard.frame();
      expect(splash).toContain("██╗");
      expect(splash).not.toContain("detected hardware");
    } finally {
      wizard.destroy();
    }
  });

  test("narrow terminals shorten the key reference instead of overlapping the counter", async () => {
    const wizard = await createWizard(52, 30);
    try {
      wizard.view.setHardware(hardwareRows(survey));
      wizard.view.show("hardware", "cuda-13.4");
      const frame = await wizard.frame();
      const line = frame.split("\n").find((row) => row.includes("hardware ·")) ?? "";
      expect(line.indexOf("cuda-13.4")).toBeGreaterThan(0);
      expect(line).not.toContain("enter continue · r rescan");
    } finally {
      wizard.destroy();
    }
  });
});
