import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";

// UI flags and presets are user preferences on disk; keep the suite hermetic.
let configDir: string;
// A fresh flags/preset directory per test: toggles such as ctrl+b and ctrl+t
// persist preferences, and one test must never inherit another's choices.
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "lazyllama-test-"));
  process.env["LAZYLLAMA_CONFIG_DIR"] = configDir;
});
afterEach(() => {
  delete process.env["LAZYLLAMA_CONFIG_DIR"];
  rmSync(configDir, { recursive: true, force: true });
});
import { defaultConfig, type LaunchConfig } from "../src/config.ts";
import type { LocalModel } from "../src/models.ts";
import type { ChatMessage } from "../src/server.ts";
import { createAppUi } from "../src/ui/controller.ts";
import { Transcript, formatAssistantFooter, formatThinkingDuration } from "../src/ui/transcript.ts";
import { formatContextCompact } from "../src/ui/prompt.ts";
import { SidePanel, type SidebarData } from "../src/ui/sidebar.ts";
import { formatContextRows, formatModelRows, formatSidebarContext, formatSystemRows } from "../src/ui/sidebar.ts";
import { DARK_THEME } from "../src/ui/theme.ts";
import { requiredEditorRows, selectEditorDensity } from "../src/ui/hubView.ts";
import { isEnterKey } from "../src/ui/keys.ts";
import type { ChatView, UiDeps, UiHandles } from "../src/ui/types.ts";

const demoModel: LocalModel = {
  name: "demo.gguf",
  path: "/models/demo.gguf",
  sizeMiB: 12,
  mtimeMs: 0,
};

interface TestUi {
  renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"];
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"];
  mockMouse: Awaited<ReturnType<typeof createTestRenderer>>["mockMouse"];
  waitForFrame: Awaited<ReturnType<typeof createTestRenderer>>["waitForFrame"];
  flush: Awaited<ReturnType<typeof createTestRenderer>>["flush"];
  captureCharFrame: Awaited<ReturnType<typeof createTestRenderer>>["captureCharFrame"];
  resize: Awaited<ReturnType<typeof createTestRenderer>>["resize"];
  ui: UiHandles;
  sent: ChatMessage[][];
  signals: AbortSignal[];
  confirmed: LaunchConfig[];
  configChanges: LaunchConfig[];
  quit: { count: number };
}

interface TestUiOptions {
  models?: LocalModel[];
  width?: number;
  height?: number;
  onSend?: UiDeps["onSend"];
  mouse?: boolean;
}

async function createTestUi(options: TestUiOptions = {}): Promise<TestUi> {
  const models = options.models ?? [demoModel];
  const setup = await createTestRenderer({
    width: options.width ?? 100,
    height: options.height ?? 40,
    useMouse: options.mouse ?? true,
    // Kitty keyboard mode reports shift/ctrl/alt as real modifier flags, so
    // binding specs such as "shift+return" are exercised faithfully.
    kittyKeyboard: true,
  });
  const sent: ChatMessage[][] = [];
  const signals: AbortSignal[] = [];
  const confirmed: LaunchConfig[] = [];
  const configChanges: LaunchConfig[] = [];
  const quit = { count: 0 };
  const deps: UiDeps = {
    config: defaultConfig(),
    localModels: models,
    getServerStatus: () => "test ready",
    getBaseUrl: () => "http://127.0.0.1:8080",
    mouse: options.mouse ?? true,
    onSend:
      options.onSend ??
      ((transcript: ChatMessage[], chat: ChatView, signal: AbortSignal) => {
        // Mirror production: the assistant placeholder exists by the time the
        // request copy is observed, so the UI must have snapshotted history first.
        const stream = chat.startAssistant();
        sent.push(transcript.map((message) => ({ ...message })));
        signals.push(signal);
        stream.done();
        chat.notice("sent");
      }),
    onConfigChange: (next) => {
      configChanges.push(next);
    },
    onRefreshModels: () => models,
    skipModelScreen: false,
    onHubConfirm: (cfg, hub) => {
      confirmed.push(cfg);
      hub.enterChat();
    },
    onQuit: () => {
      quit.count += 1;
    },
    presetStore: {
      loadPreset: () => undefined,
      savePreset: () => {},
    },
  };
  const ui = createAppUi(setup.renderer, deps, {
    splashMinMs: 60_000,
    perfIntervalMs: 0,
  });
  return {
    renderer: setup.renderer,
    mockInput: setup.mockInput,
    mockMouse: setup.mockMouse,
    waitForFrame: setup.waitForFrame,
    flush: setup.flush,
    captureCharFrame: setup.captureCharFrame,
    resize: setup.resize,
    ui,
    sent,
    signals,
    confirmed,
    configChanges,
    quit,
  };
}

async function pressAndSettle(app: TestUi, press: () => void): Promise<void> {
  press();
  await app.flush();
}

// Markdown finalization is asynchronous inside OpenTUI: give the parser real
// time plus a few render passes before asserting on rendered markdown.
async function paint(app: TestUi, ms = 220): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await app.flush();
}

describe("OpenTUI Enter handling", () => {
  test("canonical and compatibility Enter names are accepted", () => {
    expect(isEnterKey({ name: "return" })).toBe(true);
    expect(isEnterKey({ name: "enter" })).toBe(true);
    expect(isEnterKey({ name: "kpenter" })).toBe(true);
    expect(isEnterKey({ name: "linefeed" })).toBe(true);
    expect(isEnterKey({ name: "escape" })).toBe(false);
    expect(isEnterKey({ name: "up" })).toBe(false);
  });

  test("transcript renders a thinking block, markdown answer and OpenCode footer", async () => {
    const setup = await createTestRenderer({ width: 90, height: 20 });
    try {
      const transcript = new Transcript({
        renderer: setup.renderer,
        theme: DARK_THEME,
        scrollbarVisible: true,
        showThinking: true,
        throttleMs: 0,
      });
      setup.renderer.root.add(transcript.body);
      transcript.addUser("why is the cache reused?");
      const answer = transcript.beginAssistant();
      answer.pushThinking("The prompt prefix is identical, so slot 0 can reuse its KV cache.");
      answer.push("Because the prefix is unchanged, the slot reuses its KV cache.");
      answer.done({ finishReason: "stop", tokens: 12, tokPerSecond: 30.4, thoughtMs: 1400 });
      // Markdown finalization is asynchronous, so give the parser a beat.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const frame = await setup.waitForFrame((frame) => frame.includes("\u25a3 12 tok"), {
        maxPasses: 60,
      });
      expect(frame).toContain("why is the cache reused?");
      expect(frame).toContain("Thought for 1.4s");
      expect(frame).toContain("30.4 tok/s");
      expect(frame).not.toContain("llama:");
      expect(frame).not.toContain("\u256d");
      transcript.destroy();
    } finally {
      setup.renderer.destroy();
    }
  });

  test("the footer marks interrupted turns, even with no visible answer", () => {
    expect(formatAssistantFooter("partial", { interrupted: true, tokens: 4, tokPerSecond: 12 })).toBe(
      "▣ 4 tok · 12.0 tok/s · interrupted",
    );
    expect(formatAssistantFooter("", { interrupted: true })).toBe("interrupted");
    expect(formatAssistantFooter("", { finishReason: "length" })).toBe("(no response — length)");
    expect(formatAssistantFooter("done", { thoughtMs: 2400, tokens: 9, tokPerSecond: 30 })).toBe(
      "▣ 9 tok · 30.0 tok/s · thought 2.4s",
    );
  });

  test("thinking can be hidden globally and the duration is formatted", () => {
    expect(formatThinkingDuration(820)).toBe("820ms");
    expect(formatThinkingDuration(1400)).toBe("1.4s");
    expect(formatThinkingDuration(12400)).toBe("12.4s");
    expect(formatContextCompact(12345, 32768)).toBe("12.3K (38%)");
    expect(formatContextCompact(12345, 100000)).toBe("12.3K (12%)");
    expect(formatSidebarContext(undefined, undefined)).toBe("--");
  });

  test("the context block reports size, used tokens and a meter", () => {
    const rows = formatContextRows({ used: 12345, total: 32768 });
    expect(rows[0]).toMatchObject({ label: "context size", value: "32.8K" });
    expect(rows[1]).toMatchObject({ label: "used", value: "12.3K" });
    expect(rows[2]?.bar).toBeCloseTo(12345 / 32768, 5);
    expect(rows[2]?.value).toBe("38%");
    // The configured context size no longer repeats in the model block.
    const model = formatModelRows({
      name: "m",
      source: "local",
      ctxSize: 8192,
      gpuLayers: "auto",
      temp: 0.7,
      topP: 0.9,
      topK: 40,
      reasoning: "auto",
    }).map((row) => row.label);
    expect(model).not.toContain("ctx");
  });

  test("every system core gets a percentage and the same meter", () => {
    const rows = formatSystemRows({
      cpuPct: 0.25,
      perCorePct: [0, 0.5, 1, 0.75, 0.1, 0.2, 0.3, 0.4, 0.6, 0.9],
      memUsedMiB: 500,
      memTotalMiB: 1000,
      load1: 1.5,
    });
    const cores = rows.filter((row) => row.label.startsWith("c") && /^[0-9]+$/.test(row.label.slice(1)));
    expect(cores.length).toBe(10);
    expect(cores[0]?.value).toBe("0%");
    expect(cores[2]?.value).toBe("100%");
    for (const core of cores) expect(typeof core.bar).toBe("number");
    const cpu = rows.find((row) => row.label === "CPU");
    expect(cpu?.value).toBe("25%");
    expect(cpu?.bar).toBeCloseTo(0.25, 5);
  });

  test("empty model list keeps its notice and offers Hugging Face", async () => {
    const app = await createTestUi({ models: [] });
    try {
      const splash = await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      const logoLine = splash.split("\n").find((line) => line.includes("██╗"));
      expect(logoLine?.startsWith(" ")).toBe(true);
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      const frame = await app.waitForFrame((frame) => frame.includes("Select a model"));
      expect(frame).toContain("no local models");
      expect(frame).toContain("HuggingFace repo");
    } finally {
      app.ui.destroy();
    }
  });

  test("editor action buttons go back and save with keyboard focus", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));

      for (let i = 0; i < 6; i += 1) {
        app.mockInput.pressTab();
      }
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-save");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      expect(app.configChanges.length).toBe(1);

      app.mockInput.pressTab({ shift: true });
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-back");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Select a model"));
    } finally {
      app.ui.destroy();
    }
  });

  test("editor density budgets every field with scroll fallback", () => {
    expect(requiredEditorRows(19, 5, "comfortable")).toBe(41);
    expect(requiredEditorRows(19, 5, "compact")).toBe(27);
    expect(selectEditorDensity(42, 19, 5)).toBe("comfortable");
    expect(selectEditorDensity(41, 19, 5)).toBe("comfortable");
    expect(selectEditorDensity(40, 19, 5)).toBe("compact");
    expect(selectEditorDensity(24, 19, 5)).toBe("compact");
  });

  test("lateral arrows move model selection", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressArrow("right"));
      const frame = await app.waitForFrame((frame) => frame.includes("▸ HuggingFace"));
      expect(frame).toContain("demo.gguf");
      await pressAndSettle(app, () => app.mockInput.pressArrow("left"));
      await app.waitForFrame((frame) => frame.includes("▸ demo.gguf"));
    } finally {
      app.ui.destroy();
    }
  });

  test("lateral arrows move between editor action buttons", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      for (let i = 0; i < 21; i += 1) {
        app.mockInput.pressArrow("down");
      }
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-confirm");
      await pressAndSettle(app, () => app.mockInput.pressArrow("left"));
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-save");
      await pressAndSettle(app, () => app.mockInput.pressArrow("right"));
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-confirm");
    } finally {
      app.ui.destroy();
    }
  });

  test("lateral arrows adjust the in-chat config overlay", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      for (let i = 0; i < 21; i += 1) {
        app.mockInput.pressArrow("down");
      }
      await app.flush();
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Ask anything"));
      await pressAndSettle(app, () => app.mockInput.pressKey("F2"));
      await app.waitForFrame((frame) => frame.includes("Config"));
      await pressAndSettle(app, () => app.mockInput.pressArrow("right"));
      await app.waitForFrame((frame) => frame.includes("-c 1024"));
      await pressAndSettle(app, () => app.mockInput.pressArrow("left"));
      await app.waitForFrame((frame) => frame.includes("Context  -c 0"));
    } finally {
      app.ui.destroy();
    }
  });

  test("Ctrl+C requests application shutdown", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressCtrlC());
      expect(app.quit.count).toBe(1);
    } finally {
      app.ui.destroy();
    }
  });

  test("Return moves from model selection through config editing into chat", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));

      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const editorTitle = await app.waitForFrame((frame) => frame.includes("Configure —"));
      expect(editorTitle).toContain("Configure — demo");

      await pressAndSettle(app, () => app.mockInput.pressEnter());
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-edit-input");
      await app.mockInput.typeText("4096");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("context size (-c): 4096"));

      const editor = await app.waitForFrame((frame) => frame.includes("Context"));
      expect(editor).toContain("Launch");
      expect(editor).toContain("Sampling");
      expect(editor).toContain("▸");
      expect(editor).not.toContain("▶");
      // Arrow-down walks every field in every group, then the action buttons.
      // Scrolling brings later groups into view.
      for (let i = 0; i < 18; i += 1) {
        app.mockInput.pressArrow("down");
      }
      await app.flush();
      const scrolled = await app.waitForFrame((frame) => frame.includes("Advanced"));
      expect(scrolled).toContain("Network");
      for (let i = 0; i < 3; i += 1) {
        app.mockInput.pressArrow("down");
      }
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-confirm");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Ask anything"));
      expect(app.confirmed.length).toBe(1);

      await app.mockInput.typeText("hello");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const frame = await app.waitForFrame((frame) => frame.includes("hello"));
      expect(frame).toContain("sent");
      // The chat view is OpenCode-shaped: no header bar, no bottom status bar.
      expect(frame).not.toContain("lazyllama  demo");
      expect(frame).not.toContain("test ready");
      expect(frame).not.toContain("][");
      expect(frame).not.toContain("╭");
      expect(frame).not.toContain("╰");
      expect(app.sent.length).toBe(1);
      expect(app.sent[0]).toEqual([
        { role: "user", content: "hello" },
      ]);

      // A follow-up send must carry completed history without any empty
      // assistant placeholder.
      await app.mockInput.typeText("again");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("again"));
      expect(app.sent.length).toBe(2);
      expect(app.sent[1]).toEqual([
        { role: "user", content: "hello" },
        { role: "user", content: "again" },
      ]);
    } finally {
      app.ui.destroy();
    }
  });

  test("configuration overlay toggles with F2 and keyboard-only adjustments", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      for (let i = 0; i < 7; i += 1) {
        app.mockInput.pressTab();
      }
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-confirm");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Ask anything"));

      await pressAndSettle(app, () => app.mockInput.pressKey("F2"));
      await app.waitForFrame((frame) => frame.includes("Config"));
      await pressAndSettle(app, () => app.mockInput.pressKey("g"));
      await app.waitForFrame((frame) => frame.includes("-ngl 0"));
      await pressAndSettle(app, () => app.mockInput.pressKey("j"));
      await app.waitForFrame((frame) => frame.includes("--no-jinja"));
      await pressAndSettle(app, () => app.mockInput.pressEscape());
      await app.waitForFrame((frame) => frame.includes("Ask anything"));
    } finally {
      app.ui.destroy();
    }
  });
});

async function enterChat(app: TestUi): Promise<void> {
  await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
  await pressAndSettle(app, () => app.mockInput.pressKey("a"));
  await app.waitForFrame((frame) => frame.includes("demo.gguf"));
  await pressAndSettle(app, () => app.mockInput.pressEnter());
  await app.waitForFrame((frame) => frame.includes("Configure —"));
  for (let i = 0; i < 21; i += 1) app.mockInput.pressArrow("down");
  await app.flush();
  expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-confirm");
  await pressAndSettle(app, () => app.mockInput.pressEnter());
  await app.waitForFrame((frame) => frame.includes("Ask anything"));
}

describe("OpenCode-style chat layout", () => {
  test("the side panel is a column above 120 columns and holds the context meter", async () => {
    const app = await createTestUi({ width: 130, height: 30 });
    try {
      await enterChat(app);
      app.ui.setContext(12345, 32768);
      // Wait for the value, not the label, which renders before any data.
      const frame = await app.waitForFrame((frame) => frame.includes("12.3K"));
      expect(frame).toContain("Model");
      expect(frame).toContain("Server");
      expect(frame).toContain("System");
      expect(frame).toContain("used");
      expect(frame).toContain("12.3K");
      expect(frame).toContain("38%");
      expect(frame).toContain("32.8K");
      // Context lives in the panel; the chat view has no header or status bar.
      expect(frame).not.toContain("lazyllama  demo");
      expect(app.renderer.root.findDescendantById("sidebar")?.visible).toBe(true);
    } finally {
      app.ui.destroy();
    }
  });

  test("below the breakpoint the panel is hidden and ctrl+b forces it as an overlay", async () => {
    const app = await createTestUi({ width: 100, height: 30 });
    try {
      await enterChat(app);
      expect(app.renderer.root.findDescendantById("sidebar")?.visible).toBe(false);
      await pressAndSettle(app, () => app.mockInput.pressKey("b", { ctrl: true }));
      const frame = await app.waitForFrame((frame) => frame.includes("Context"));
      expect(frame).toContain("Model");
      expect(app.renderer.root.findDescendantById("sidebar")?.visible).toBe(true);
      await pressAndSettle(app, () => app.mockInput.pressKey("b", { ctrl: true }));
      const hidden = await app.waitForFrame((frame) => !frame.includes("Context"));
      expect(app.renderer.root.findDescendantById("sidebar")?.visible).toBe(false);
    } finally {
      app.ui.destroy();
    }
  });

  test("the prompt is an OpenCode L-shaped box with an esc interrupt hint", async () => {
    const app = await createTestUi({ width: 100, height: 30 });
    try {
      await enterChat(app);
      const frame = await app.waitForFrame((frame) => frame.includes("esc interrupt"));
      expect(frame).toContain("╹");
      expect(frame).toContain("▀");
      expect(frame).not.toContain("╭");
      expect(app.renderer.currentFocusedRenderable?.id).toBe("prompt-editor");
    } finally {
      app.ui.destroy();
    }
  });

  test("return sends and shift+return inserts a newline", async () => {
    const app = await createTestUi();
    try {
      await enterChat(app);
      await app.mockInput.typeText("first line");
      await pressAndSettle(app, () => app.mockInput.pressEnter({ shift: true }));
      await app.mockInput.typeText("second line");
      await paint(app);
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const frame = await app.waitForFrame((frame) => frame.includes("second line"));
      expect(app.sent.length).toBe(1);
      expect(app.sent[0]).toEqual([{ role: "user", content: "first line\nsecond line" }]);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("interrupt handling", () => {
  test("the prompt footer keeps the model name and shows no thinking spinner", async () => {
    const app = await createTestUi({
      onSend: (_transcript, chat) => {
        const stream = chat.startAssistant();
        stream.push("answer");
        // Intentionally left streaming: the busy state is what matters.
      },
    });
    try {
      await enterChat(app);
      const idle = await app.waitForFrame((frame) => frame.includes("demo"));
      expect(idle).toContain("esc interrupt");
      // Typing must not displace the model name from the left footer slot.
      await app.mockInput.typeText("typing");
      const typed = await app.waitForFrame((frame) => frame.includes("typing"));
      expect(typed).toContain("demo");
      expect(typed).toContain("esc interrupt");
    } finally {
      app.ui.destroy();
    }
  });

  test("escape arms first, then aborts the in-flight request", async () => {
    const signals: AbortSignal[] = [];
    const app = await createTestUi({
      onSend: (_transcript, chat, signal) => {
        const stream = chat.startAssistant();
        signals.push(signal);
        stream.push("partial answer");
        // Intentionally never finishes: the test drives the abort itself.
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("keep going");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const busy = await app.waitForFrame((frame) => frame.includes("esc interrupt"));
      expect(busy).toContain("partial answer");
      expect(signals[0]?.aborted).toBe(false);

      await pressAndSettle(app, () => app.mockInput.pressEscape());
      const armed = await app.waitForFrame((frame) => frame.includes("esc again to interrupt"));
      expect(armed).toContain("esc again to interrupt");
      expect(signals[0]?.aborted).toBe(false);

      await pressAndSettle(app, () => app.mockInput.pressEscape());
      await app.flush();
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      app.ui.destroy();
    }
  });

  test("escape on an idle session with text clears the prompt instead", async () => {
    const app = await createTestUi();
    try {
      await enterChat(app);
      await app.mockInput.typeText("draft text");
      await app.flush();
      await pressAndSettle(app, () => app.mockInput.pressEscape());
      await app.waitForFrame((frame) => !frame.includes("draft text"));
      expect(app.sent.length).toBe(0);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("mouse interaction", () => {
  test("the wheel scrolls the transcript and click focuses the prompt", async () => {
    const app = await createTestUi({ width: 100, height: 24 });
    try {
      await enterChat(app);
      for (let i = 0; i < 12; i += 1) {
        app.ui.user(`message number ${i} with enough words to take a couple of rows`);
      }
      await app.flush();
      const transcript = app.renderer.root.findDescendantById("transcript") as unknown as {
        scrollTop: number;
        scrollBy(n: number): void;
      };
      const box = app.renderer.root.findDescendantById("transcript") as unknown as {
        x: number;
        y: number;
        width: number;
        height: number;
        scrollTop: number;
        scrollHeight: number;
        scrollTo(n: number): void;
      };
      // New content sticks to the bottom...
      await app.flush();
      expect(box.scrollTop).toBe(box.scrollHeight - box.height);
      // ...and the wheel scrolls away from it.
      const x = Math.floor(box.x + box.width / 2);
      const y = Math.floor(box.y + 2);
      await app.mockMouse.scroll(x, y, "up");
      await app.mockMouse.scroll(x, y, "up");
      await app.mockMouse.scroll(x, y, "up");
      await app.flush();
      expect(box.scrollTop).toBeLessThan(box.scrollHeight - box.height);
      // Returning to the bottom re-engages stickiness.
      box.scrollTo(box.scrollHeight);
      await app.flush();
      expect(box.scrollTop).toBe(box.scrollHeight - box.height);

      // Clicking the prompt focuses it again after the panel took the cursor.
      const editor = app.renderer.root.findDescendantById("prompt-editor");
      await pressAndSettle(app, () => app.mockInput.pressKey("b", { ctrl: true, option: true }));
      await app.mockMouse.click(Math.floor((editor?.x ?? 0) + 2), Math.floor((editor?.y ?? 0) + 1));
      await app.flush();
      expect(app.renderer.currentFocusedRenderable?.id).toBe("prompt-editor");
    } finally {
      app.ui.destroy();
    }
  });
});

describe("thinking display", () => {
  test("ctrl+t toggles model thinking blocks", async () => {
    const app = await createTestUi({
      onSend: (_transcript, chat) => {
        const stream = chat.startAssistant();
        stream.pushThinking("weighing the options");
        stream.push("the answer");
        stream.done({ finishReason: "stop", tokens: 3, tokPerSecond: 20, thoughtMs: 900 });
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("think please");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      // Markdown finalization plus the 80ms thinking ticker make this the
      // slowest frame in the suite: give both a generous margin.
      await paint(app, 350);
      const shown = await app.waitForFrame((frame) => frame.includes("Thought"), { maxPasses: 120 });
      expect(shown).toContain("weighing the options");
      expect(shown).toContain("the answer");
      await pressAndSettle(app, () => app.mockInput.pressKey("t", { ctrl: true }));
      await paint(app, 250);
      const hidden = await app.waitForFrame((frame) => !frame.includes("Thought"), { maxPasses: 120 });
      expect(hidden).toContain("the answer");
      expect(hidden).not.toContain("weighing the options");
    } finally {
      app.ui.destroy();
    }
  });
});

describe("the gpu section of the side panel", () => {
  const GIB = 1024 ** 3;

  async function panelWith(gpu: SidebarData["gpu"]): Promise<{
    frame: string;
    section: (() => ReturnType<typeof setup_find>) | null;
    destroy(): void;
  }> {
    const setup = await createTestRenderer({ width: 100, height: 44 });
    const panel = new SidePanel(setup.renderer, DARK_THEME);
    setup.renderer.root.add(panel.body);
    panel.setMode("column");
    panel.setData({
      model: { name: "demo", source: "local", ctxSize: 8192, gpuLayers: "auto", temp: null, topP: 0.9, topK: 40, reasoning: "auto" },
      server: { baseUrl: "http://127.0.0.1:8080", slotId: 0, nCtx: 8192, props: true, metrics: true, processing: false },
      context: { used: 100, total: 8192 },
      gpu,
      system: { cpuPct: 0.2, perCorePct: [0.1, 0.2], memUsedMiB: 1000, memTotalMiB: 16000, load1: 0.5 },
    });
    for (let i = 0; i < 3; i += 1) await setup.renderOnce();
    return {
      frame: setup.captureCharFrame(),
      section: () => setup.renderer.root.findDescendantById("sidebar-section-gpu"),
      destroy: () => setup.renderer.destroy(),
    };
  }
  function setup_find() {
    return undefined as unknown as { visible: boolean };
  }

  test("a machine with no gpu shows no gpu section at all", async () => {
    const panel = await panelWith([]);
    try {
      expect(panel.frame).not.toContain("GPU");
      expect(panel.section()?.visible).toBe(false);
    } finally {
      panel.destroy();
    }
  });

  test("a card gets its name, a meter and a used line", async () => {
    const panel = await panelWith([
      { vendor: "nvidia", name: "NVIDIA GeForce RTX 4070", totalBytes: 12 * GIB, usedBytes: 6 * GIB, shared: false },
    ]);
    try {
      expect(panel.frame).toContain("GPU");
      expect(panel.frame).toContain("NVIDIA GeForce RTX 4070");
      expect(panel.frame).toContain("50%");
      expect(panel.frame).toContain("6.0 / 12 GiB");
      expect(panel.section()?.visible).toBe(true);
    } finally {
      panel.destroy();
    }
  });
});

describe("side panel belongs to the chat screen only", () => {
  test("the picker and editor screens keep the full terminal width", async () => {
    const app = await createTestUi({ width: 130, height: 30 });
    try {
      const sidebar = () => app.renderer.root.findDescendantById("sidebar");
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      expect(sidebar()?.visible).toBe(false);

      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      const picker = await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      expect(picker).not.toContain("n_ctx");
      expect(sidebar()?.visible).toBe(false);

      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const editor = await app.waitForFrame((frame) => frame.includes("Configure —"));
      expect(editor).not.toContain("n_ctx");
      expect(editor).not.toContain("tok/s");
      expect(sidebar()?.visible).toBe(false);

      for (let i = 0; i < 21; i += 1) app.mockInput.pressArrow("down");
      await app.flush();
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const chat = await app.waitForFrame((frame) => frame.includes("n_ctx"));
      expect(chat).toContain("System");
      expect(chat).toContain("context size");
      expect(sidebar()?.visible).toBe(true);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("editor fills the screen and scrolls from the right edge", () => {
  test("a tall terminal shows every field without clipping", async () => {
    const app = await createTestUi({ width: 190, height: 50 });
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const frame = await app.waitForFrame((frame) => frame.includes("extra args (raw)"));
      expect(frame).toContain("Network");
      expect(frame).toContain("metrics endpoint");
      // Nothing overflows, so no scrollbar is painted.
      const groups = app.renderer.root.findDescendantById("hub-groups") as unknown as {
        verticalScrollBar: { visible: boolean };
      };
      expect(groups.verticalScrollBar.visible).toBe(false);
    } finally {
      app.ui.destroy();
    }
  });

  test("a short terminal scrolls the focused field into view", async () => {
    const app = await createTestUi({ width: 100, height: 18 });
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      const groups = app.renderer.root.findDescendantById("hub-groups") as unknown as {
        scrollTop: number;
        width: number;
        verticalScrollBar: { visible: boolean; x: number };
      };
      expect(groups.scrollTop).toBe(0);
      // Overflowing content paints the bar on the right edge of the column.
      expect(groups.verticalScrollBar.visible).toBe(true);
      expect(groups.verticalScrollBar.x).toBeGreaterThan(groups.width - 4);
      for (let i = 0; i < 18; i += 1) app.mockInput.pressArrow("down");
      await app.flush();
      const frame = await app.waitForFrame((frame) => frame.includes("extra args (raw)"));
      expect(groups.scrollTop).toBeGreaterThan(0);
      expect(frame).toContain("extra args (raw)");
    } finally {
      app.ui.destroy();
    }
  });
});

describe("chat message shape", () => {
  test("assistant turns are plain indented text with a collapsible thought line", async () => {
    const app = await createTestUi({
      onSend: (_transcript, chat) => {
        const stream = chat.startAssistant();
        stream.pushThinking("weighing the options");
        stream.push("the answer");
        stream.done({ finishReason: "stop", tokens: 3, tokPerSecond: 20, thoughtMs: 900 });
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("hello");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await paint(app, 300);
      // Wait for the finalized state: the thought header, its markdown body and
      // the footer can settle on different frames.
      const frame = await app.waitForFrame(
        (frame) => frame.includes("▾ Thought for 900ms") && frame.includes("weighing the options"),
        { maxPasses: 150 },
      );
      const lines = frame.split("\n");
      const header = lines.find((line) => line.includes("▾ Thought for 900ms"));
      const thought = lines.find((line) => line.includes("weighing the options"));
      const answer = lines.find((line) => line.includes("the answer"));
      const footer = lines.find((line) => line.includes("▣ 3 tok"));
      expect(header).toBeDefined();
      expect(thought).toBeDefined();
      expect(answer).toBeDefined();
      expect(footer).toBeDefined();
      // Thought, answer and footer share one column, and no rule is drawn.
      const column = (line: string | undefined): number => (line ?? "").search(/\S/);
      const textColumn = column(answer);
      expect(column(header)).toBe(textColumn);
      expect(column(thought)).toBe(textColumn);
      expect(column(footer)).toBe(textColumn);
      expect(answer).not.toContain("┃");
      expect(header).not.toContain("┃");
      expect(footer).not.toContain("┃");
      // The user message keeps its panel rule, with the text on the same column.
      const user = lines.find((line) => line.includes("hello"));
      expect(user?.trimStart().startsWith("┃")).toBe(true);
      expect(user?.indexOf("hello")).toBe(textColumn);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("toggleable options in the config editor", () => {
  test("sampling parameters can be switched off and back on", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      // Nine fields precede temperature (3 context + 6 launch). Stepping past
      // its maximum switches it off; stepping from off turns it back on.
      const walk = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i += 1) app.mockInput.pressArrow("down");
        await app.flush();
      };
      await walk(9);
      let frame = await app.waitForFrame((frame) => frame.includes("temperature: 0.7"));
      expect(frame).toContain("▸ temperature: 0.7");
      for (let i = 0; i < 14; i += 1) app.mockInput.pressArrow("right");
      await app.flush();
      frame = await app.waitForFrame((frame) => frame.includes("temperature: off"));
      expect(frame).toContain("▸ temperature: off");
      await pressAndSettle(app, () => app.mockInput.pressArrow("left"));
      frame = await app.waitForFrame((frame) => frame.includes("temperature: 2"));
      expect(frame).toContain("▸ temperature: 2");
    } finally {
      app.ui.destroy();
    }
  });

  test("exactly one editor row is marked, whatever the navigation history", async () => {
    const app = await createTestUi();
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("demo.gguf"));
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await app.waitForFrame((frame) => frame.includes("Configure —"));
      for (let i = 0; i < 9; i += 1) app.mockInput.pressArrow("down");
      for (let i = 0; i < 6; i += 1) app.mockInput.pressArrow("right");
      for (let i = 0; i < 5; i += 1) app.mockInput.pressArrow("down");
      for (let i = 0; i < 4; i += 1) app.mockInput.pressArrow("left");
      await app.flush();
      const frame = await app.waitForFrame((frame) => frame.includes("▸"));
      const marked = frame.split("\n").filter((line) => line.includes("▸"));
      expect(marked.length).toBe(1);
      // The marker follows the focused field, not a stale one: 9 downs reach
      // temperature, 5 more land in the network group.
      expect(app.renderer.currentFocusedRenderable?.id).toBe("hub-group-network-select");
      expect(marked[0]).toContain("host");
    } finally {
      app.ui.destroy();
    }
  });

  test("a switched-off parameter is left out of the server flags", async () => {
    const { defaultConfig: fresh, toServerArgs } = await import("../src/config.ts");
    const cfg = fresh();
    cfg.model = { kind: "local", path: "/m/q.gguf" };
    cfg.temp = null;
    cfg.topP = null;
    cfg.topK = null;
    cfg.repeatPenalty = null;
    const args = toServerArgs(cfg);
    expect(args).not.toContain("--temp");
    expect(args).not.toContain("--top-p");
    expect(args).not.toContain("--top-k");
    expect(args).not.toContain("--repeat-penalty");
    expect(args).toContain("-c");
  });
});

describe("thinking and thought never coexist", () => {
  test("the live placeholder is replaced by the thought block", async () => {
    let pushThinking: ((token: string) => void) | undefined;
    const app = await createTestUi({
      onSend: (_transcript, chat) => {
        // Deliberately left streaming so the live states can be inspected.
        const stream = chat.startAssistant();
        pushThinking = (token) => stream.pushThinking(token);
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("think");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const spinner = await app.waitForFrame((frame) => frame.includes("esc interrupt"));
      expect(spinner).not.toContain("Thought");
      // Message ids come from a per-Transcript counter, so locate the live
      // placeholder by suffix instead of hard-coding a number.
      const findBySuffix = (suffix: string): { visible: boolean } | undefined => {
        const walk = (node: { id: string; visible: boolean; getChildren?: () => unknown[] }): { visible: boolean } | undefined => {
          if (node.id.endsWith(suffix)) return node;
          for (const child of (node.getChildren?.() ?? []) as typeof node[]) {
            const hit = walk(child);
            if (hit) return hit;
          }
          return undefined;
        };
        return walk(app.renderer.root as unknown as { id: string; visible: boolean; getChildren?: () => unknown[] });
      };
      const pending = (): { visible: boolean } | undefined => findBySuffix("-pending");
      expect(pending()?.visible).toBe(true);

      // Reasoning arrives: the in-transcript placeholder is replaced by the
      // thought block, and the header claims no duration yet. The prompt
      // footer keeps its own busy spinner, which is a different element.
      pushThinking?.("weighing the options");
      const thinking = await app.waitForFrame((frame) => frame.includes("weighing"), { maxPasses: 40 });
      expect(pending()?.visible).toBe(false);
      expect(thinking).toContain("thinking…");
      expect(thinking).not.toContain("Thought for");
      // The animation is the same Braille spinner OpenCode uses, in the
      // transcript rather than the prompt box.
      expect(thinking).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking…/);
      const transcriptFrames = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        await app.flush();
        await new Promise((resolve) => setTimeout(resolve, 90));
        const current = app.captureCharFrame();
        const match = current.match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) thinking…/);
        if (match) transcriptFrames.add(match[1]!);
      }
      expect(transcriptFrames.size).toBeGreaterThan(1);
      // ...and the prompt's own footer line never shows one.
      const footer = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("esc interrupt"));
      expect(footer).toBeDefined();
      expect(footer).toContain("demo");
      expect(footer).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("hub screens have no header, only a footer", () => {
  test("the command reference lives on the last row", async () => {
    const app = await createTestUi({ width: 130, height: 30 });
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      const picker = await app.waitForFrame((frame) => frame.includes("Select a model"));
      const pickerLines = picker.split("\n").filter((line) => line.trim().length > 0);
      expect(pickerLines[0]).toContain("Select a model");
      expect(pickerLines[pickerLines.length - 1]).toContain("Enter open");
      expect(picker).not.toContain("lazyllama");

      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const editor = await app.waitForFrame((frame) => frame.includes("Configure —"));
      const editorLines = editor.split("\n").filter((line) => line.trim().length > 0);
      expect(editorLines[0]).toContain("Configure —");
      const footerLine = editorLines[editorLines.length - 1];
      expect(footerLine).toContain("←/→ adjust");
      expect(footerLine).toContain("Ctrl+C quit");
      expect(footerLine).toContain("demo");
      expect(editor).not.toContain("lazyllama");

      // Chat keeps OpenCode's chrome-free layout.
      for (let i = 0; i < 21; i += 1) app.mockInput.pressArrow("down");
      await app.flush();
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      const chat = await app.waitForFrame((frame) => frame.includes("Ask anything"));
      expect(chat).not.toContain("lazyllama");
      expect(chat).not.toContain("Ctrl+C quit");
    } finally {
      app.ui.destroy();
    }
  });
});

describe("message spacing", () => {
  test("the transcript keeps two blank rows above the first message", async () => {
    const app = await createTestUi({ width: 110, height: 24 });
    try {
      await enterChat(app);
      app.ui.user("hi bro");
      const frame = await app.waitForFrame((frame) => frame.includes("hi bro"));
      const lines = frame.split("\n");
      const row = lines.findIndex((line) => line.includes("hi bro"));
      expect(row).toBeGreaterThanOrEqual(2);
      expect(lines[0]?.trim()).toBe("");
      expect(lines[1]?.trim()).toBe("");
    } finally {
      app.ui.destroy();
    }
  });

  test("the prompt dock keeps a blank row between itself and the last message", async () => {
    const app = await createTestUi({
      width: 110,
      height: 22,
      onSend: (_transcript, chat) => {
        const stream = chat.startAssistant();
        stream.push("ok");
        stream.done({ finishReason: "stop", tokens: 1, tokPerSecond: 9 });
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("hi");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await paint(app);
      const frame = await app.waitForFrame((frame) => frame.includes("▣ 1 tok"), { maxPasses: 60 });
      const lines = frame.split("\n");
      const footer = lines.findIndex((line) => line.includes("▣ 1 tok"));
      const rule = lines.findIndex((line) => line.includes("╹"));
      expect(footer).toBeGreaterThanOrEqual(0);
      expect(rule).toBeGreaterThan(footer);
      // At least one empty row separates the footer from the prompt rule.
      expect(lines[footer + 1]?.trim()).toBe("");
    } finally {
      app.ui.destroy();
    }
  });

  test("a reply never touches the message above it", async () => {
    const app = await createTestUi({
      onSend: (_transcript, chat) => {
        const stream = chat.startAssistant();
        stream.push("ok");
        stream.done({ finishReason: "stop", tokens: 1, tokPerSecond: 9 });
      },
    });
    try {
      await enterChat(app);
      await app.mockInput.typeText("hi");
      await pressAndSettle(app, () => app.mockInput.pressEnter());
      await paint(app);
      const frame = await app.waitForFrame((frame) => frame.includes("▣ 1 tok"), { maxPasses: 60 });
      const lines = frame.split("\n");
      const user = lines.findIndex((line) => line.includes("hi"));
      const answer = lines.findIndex((line) => line.includes("ok"));
      expect(user).toBeGreaterThanOrEqual(0);
      expect(answer).toBeGreaterThan(user + 1);
    } finally {
      app.ui.destroy();
    }
  });
});

describe("mouse support on the hub screens", () => {
  test("clicking a model row opens it", async () => {
    const app = await createTestUi({
      models: [
        demoModel,
        { name: "second.gguf", path: "/models/second.gguf", sizeMiB: 4, mtimeMs: 2 },
      ],
    });
    try {
      await app.waitForFrame((frame) => frame.includes("loading lazyllama"));
      await pressAndSettle(app, () => app.mockInput.pressKey("a"));
      await app.waitForFrame((frame) => frame.includes("second.gguf"));
      const select = app.renderer.root.findDescendantById("hub-models") as unknown as {
        y: number;
      };
      // Row 1 is the second model.
      await app.mockMouse.click(6, Math.floor(select.y) + 1);
      await app.flush();
      const frame = await app.waitForFrame((frame) => frame.includes("Configure — second"));
      expect(frame).toContain("Configure — second");
    } finally {
      app.ui.destroy();
    }
  });
});
