// lazyllama entry: hub-first boot (pick model -> configure -> confirm),
// then the managed llama-server lifecycle and streaming chat.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultConfig,
  loadPreset,
  modelDisplayName,
  modelId,
  savePreset,
  toServerArgs,
  type LaunchConfig,
} from "./config.js";
import { scanLocalModels } from "./models.js";
import { ServerManager, readNCtx, streamChat, type ChatMessage } from "./server.js";
import { createShutdown } from "./shutdown.js";
import { runUi, type ChatView, type HubControl } from "./ui.js";

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

const USAGE = `lazyllama — a keyboard-first terminal client for a local llama-server

  bun run dev [options]

  --model <file|hf:user/repo>   skip the model picker and open the config editor
  --ctx <tokens>                 context window size
  --port <port>                  server port (default 8080)
  --host <host>                  server bind address
  --no-mouse                     turn off mouse reporting (LAZYLLAMA_NO_MOUSE=1 does the same)
  --help                         this text
  --version                      the installed version

Models come from LAZYLLAMA_MODELS_DIR, then the directory chosen by
\`bun run install\` (default ~/lazyllama-models), then ./models.
Run \`bun run install\` to provision a llama-server and put lazyllama on PATH.
`;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
      version?: string;
    }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgv(argv: string[]): Partial<LaunchConfig> & { modelFlag?: string; mouse?: boolean } {
  const out: Partial<LaunchConfig> & { modelFlag?: string; mouse?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--port" && next) {
      out.port = Number(next);
      i += 1;
    } else if (a === "--host" && next) {
      out.host = next;
      i += 1;
    } else if (a === "--model" && next) {
      out.modelFlag = next;
      i += 1;
    } else if (a === "--no-mouse") {
      out.mouse = false;
    } else if ((a === "--ctx" || a === "-c") && next) {
      out.ctxSize = Number(next);
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(packageVersion());
    return;
  }
  const flags = parseArgv(argv);
  let cfg: LaunchConfig = defaultConfig();
  if (flags.modelFlag) {
    const m = flags.modelFlag;
    cfg.model = m.startsWith("hf:")
      ? { kind: "hf", repo: m.slice(3) }
      : m.includes("/") && !m.endsWith(".gguf")
        ? { kind: "hf", repo: m }
        : { kind: "local", path: m };
    const preset = loadPreset(modelId(cfg.model));
    if (preset) cfg = { ...cfg, ...preset };
  }
  cfg = {
    ...cfg,
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.host ? { host: flags.host } : {}),
    ...(flags.ctxSize !== undefined ? { ctxSize: flags.ctxSize } : {}),
  };

  let status = "hub";
  let server: ServerManager | null = null;

  const ui = await runUi({
    config: cfg,
    localModels: scanLocalModels(),
    getServerStatus: () => status,
    getBaseUrl: () => server?.baseUrl() ?? "",
    onConfigChange: (next) => {
      cfg = next;
      if (cfg.model) savePreset(modelId(cfg.model), cfg);
    },
    onRefreshModels: () => scanLocalModels(),
    skipModelScreen: flags.modelFlag !== undefined && cfg.model !== null,
    mouse: flags.mouse,
    onHubConfirm: (finalCfg, hub: HubControl) => {
      void bootServer(finalCfg, hub);
    },
    onQuit: () => shutdownController.shutdown(),
    onSend: (transcript, chat, signal) => {
      if (!server || !server.running()) {
        chat.notice("Server is not running.");
        return;
      }
      const stream = chat.startAssistant();
      void (async () => {
        try {
          const usage = await streamChat(
            server.baseUrl(),
            {
              messages: transcript,
              // null sampling params mean off: map to undefined so the key
              // is left out of the request body and llama.cpp decides.
              temperature: cfg.temp ?? undefined,
              topP: cfg.topP ?? undefined,
              topK: cfg.topK ?? undefined,
              idSlot: 0,
              cachePrompt: true,
              nKeep: cfg.keepTokens,
              reasoningFormat: cfg.reasoning,
              signal,
              onReasoning: (token) => stream.pushThinking(token),
            },
            (token) => stream.push(token),
          );
          stream.done({
            finishReason: usage.finishReason,
            tokPerSecond: usage.timings?.predictedPerSecond,
            tokens: usage.timings?.predictedN,
            thoughtMs: usage.thoughtMs,
          });
          // Server timings give the exact context footprint:
          // cached + prompt + predicted tokens.
          const used = usage.timings
            ? usage.timings.cacheN + usage.timings.promptN + usage.timings.predictedN
            : usage.promptTokens;
          ui.setRequestStats(usage.timings?.predictedPerSecond);
          if (used !== undefined) {
            try {
              const props = await server.props();
              ui.setContext(used, readNCtx(props));
            } catch {
              ui.setContext(used, undefined);
            }
          }
        } catch (err) {
          if (shutdownController.isShuttingDown()) return;
          // Closing the connection is how generation is stopped: llama-server
          // cancels the task and releases the slot (it polls req.should_stop).
          if (signal.aborted || isAbortError(err)) {
            stream.done({ interrupted: true, thoughtMs: undefined });
            return;
          }
          stream.done();
          chat.notice(`request failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
  });

  async function bootServer(finalCfg: LaunchConfig, hub: HubControl): Promise<void> {
    if (shutdownController.isShuttingDown()) return;
    cfg = finalCfg;
    if (!cfg.model) {
      hub.setHubStatus("pick a model first");
      return;
    }
    if (cfg.model) savePreset(modelId(cfg.model), cfg);
    await server?.stop();
    if (shutdownController.isShuttingDown()) return;
    server = new ServerManager(toServerArgs(cfg), cfg.host, cfg.port);
    status = "starting server...";
    ui.setStatus(status);
    hub.setHubStatus(`model: ${modelDisplayName(cfg.model)}\n${status}`);
    try {
      await server.start();
      if (shutdownController.isShuttingDown()) {
        await server.stop();
        return;
      }
      const props = await server.props().catch(() => undefined);
      const nCtx = readNCtx(props);
      if (nCtx !== undefined) ui.setContext(undefined, nCtx);
      status = "server ready";
      ui.setStatus(status);
      hub.enterChat();
    } catch (err) {
      if (shutdownController.isShuttingDown()) return;
      status = `server failed: ${err instanceof Error ? err.message : String(err)}`;
      ui.setStatus(status);
      hub.setHubStatus(`${status} — adjust config and confirm again`);
    }
  }

  // Window close arrives as SIGHUP; Ctrl+C/SIGINT/SIGTERM cover the rest.
  // The helper is idempotent and unregisters every signal once it runs.
  const shutdownController = createShutdown({
    stopServer: () => server?.stop() ?? Promise.resolve(),
    destroyUi: () => ui.destroy(),
    exit: (code) => process.exit(code),
    onSignal: (signal, handler) => process.on(signal, handler),
    offSignal: (signal, handler) => process.removeListener(signal, handler),
  });
}

void main();
