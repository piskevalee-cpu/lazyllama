// Owns one llama-server child process: spawn/kill, readiness polling,
// thin REST helpers (health/props/models) and SSE chat streaming.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findServerBinary, readReceipt, serverInstallDir } from "./installer.js";

// Resolution order: explicit env -> installer receipt -> installer dir
// scan -> local cmake build -> error with the one-command fix.
export function resolveServerBinary(): string {
  const fromEnv = process.env["LAZYLLAMA_SERVER_BIN"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const receipt = readReceipt();
  if (receipt) return receipt.binary;
  const found = findServerBinary(serverInstallDir());
  if (found) return found;
  const local = join(process.cwd(), "llama.cpp", "build", "bin", "llama-server");
  if (existsSync(local)) return local;
  throw new Error(
    "llama-server binary not found. Run `bun run install:server` (downloads a " +
      "prebuilt binary, compiles from llama.cpp/ as fallback), set LAZYLLAMA_SERVER_BIN, " +
      "or download a release from https://github.com/ggml-org/llama.cpp/releases",
  );
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatTimings {
  cacheN: number;
  promptN: number;
  predictedN: number;
  predictedPerSecond: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  text: string;
  /** Model thinking text, only produced when `reasoning_format` is not "none". */
  reasoning: string;
  finishReason?: string;
  timings?: ChatTimings;
  /** Wall time from request start to the first token of any kind. */
  ttftMs?: number;
  /** Wall time from request start to the first content token: prompt
   *  prefill plus however long the model spent thinking. */
  thoughtMs?: number;
}

interface ParsedChatChunk {
  texts: string[];
  reasoning: string[];
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
  timings?: ChatTimings;
}

// Normalize llama.cpp OpenAI-compatible streaming payloads. Streaming deltas
// carry `choices[0].delta.content`, while some responses only populate the
// final `choices[0].message.content`.
export function parseChatChunkEvent(event: unknown): ParsedChatChunk {
  const texts: string[] = [];
  const reasoning: string[] = [];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let finishReason: string | undefined;
  let timings: ChatTimings | undefined;
  if (typeof event === "object" && event !== null) {
    const evt = event as {
      choices?: Array<{
        delta?: { content?: unknown; reasoning_content?: unknown };
        message?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      timings?: {
        cache_n?: unknown;
        prompt_n?: unknown;
        predicted_n?: unknown;
        predicted_per_second?: unknown;
      };
    };
    const choice = Array.isArray(evt.choices) ? evt.choices[0] : undefined;
    for (const content of [choice?.delta?.content, choice?.message?.content]) {
      if (typeof content === "string" && content.length > 0) texts.push(content);
    }
    // llama.cpp separates thinking into `reasoning_content` when
    // reasoning_format is not "none" (tools/server/server-chat.cpp).
    for (const think of [choice?.delta?.reasoning_content, choice?.message?.reasoning_content]) {
      if (typeof think === "string" && think.length > 0) reasoning.push(think);
    }
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (typeof evt.usage?.prompt_tokens === "number") promptTokens = evt.usage.prompt_tokens;
    if (typeof evt.usage?.completion_tokens === "number") {
      completionTokens = evt.usage.completion_tokens;
    }
    const raw = evt.timings;
    if (
      typeof raw?.cache_n === "number" &&
      typeof raw?.prompt_n === "number" &&
      typeof raw?.predicted_n === "number" &&
      typeof raw?.predicted_per_second === "number"
    ) {
      timings = {
        cacheN: raw.cache_n,
        promptN: raw.prompt_n,
        predictedN: raw.predicted_n,
        predictedPerSecond: raw.predicted_per_second,
      };
    }
  }
  return { texts, reasoning, promptTokens, completionTokens, finishReason, timings };
}

// Read the context window from /props. llama.cpp nests it under
// default_generation_settings; older responses carry it top-level.
export function readNCtx(props: Record<string, unknown> | undefined): number | undefined {
  if (!props) return undefined;
  const top = props["n_ctx"];
  if (typeof top === "number") return top;
  const settings = props["default_generation_settings"];
  if (typeof settings === "object" && settings !== null) {
    const nested = (settings as Record<string, unknown>)["n_ctx"];
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

export async function assertServerPortFree(
  isHealthy: () => Promise<boolean>,
  baseUrl: string,
): Promise<void> {
  if (await isHealthy()) {
    throw new Error(
      `Another server is already responding at ${baseUrl}. Stop that server or use a different host/port.`,
    );
  }
}

export function childStartError(
  exitCode: number | null,
  baseUrl: string,
  exitError?: unknown,
): Error | undefined {
  if (exitCode === null) return undefined;
  if (exitError instanceof Error) return exitError;
  return new Error(`llama-server exited early (code ${exitCode}) while starting ${baseUrl}`);
}

export class ServerManager {
  private proc: ChildProcess | null = null;

  constructor(
    private readonly serverArgs: string[],
    private readonly host = "127.0.0.1",
    private readonly port = 8080,
  ) {}

  baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(timeoutMs = 60000): Promise<void> {
    if (this.running()) return;
    await assertServerPortFree(() => this.health(), this.baseUrl());
    const bin = resolveServerBinary();
    const proc = spawn(bin, [...this.serverArgs, "--host", this.host, "--port", String(this.port)], {
      stdio: "ignore",
    });
    this.proc = proc;
    let exitError: unknown;
    const earlyExit = new Promise<never>((_, reject) => {
      proc.on("error", (err) => {
        exitError = err;
        reject(err);
      });
      proc.on("exit", (code) => {
        exitError = new Error(`llama-server exited early (code ${code})`);
        reject(exitError);
      });
    });
    try {
      await Promise.race([this.waitReady(timeoutMs), earlyExit]);
    } catch (err) {
      await this.stop();
      throw err;
    }
    const startError = childStartError(proc.exitCode, this.baseUrl(), exitError);
    if (startError) {
      await this.stop();
      throw startError;
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await this.health()) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`llama-server not ready after ${timeoutMs}ms (${this.baseUrl()}/health)`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // Global properties: n_ctx for the context bar, model path, etc.
  // Returns raw JSON; callers pick fields defensively (schema is versioned).
  async props(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl()}/props`);
    if (!res.ok) throw new Error(`GET /props -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async models(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl()}/models`);
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      if (!Array.isArray(body.data)) return [];
      return body.data.map((m) => m.id ?? "").filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
  topP?: number;
  topK?: number;
  // Pin the conversation to one server slot so llama.cpp's prompt KV cache
  // (`cache_prompt`) can reuse the shared prefix across turns instead of
  // re-evaluating history from scratch.
  idSlot?: number;
  cachePrompt?: boolean;
  nKeep?: number;
  reasoningFormat?: "auto" | "none";
  /** Injected in tests; defaults to the wall clock. */
  now?: () => number;
  /** Called with each thinking delta, when the server separates reasoning. */
  onReasoning?: (token: string) => void;
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  id_slot: number;
  cache_prompt: boolean;
  n_keep: number;
  reasoning_format: "auto" | "none";
}

// Build the exact `/v1/chat/completions` payload. Pure so the conversation
// shape (full history, pinned slot, cache reuse) stays unit-testable.
export function buildChatRequestBody(
  messages: ChatMessage[],
  opts: Pick<
    StreamChatOptions,
    "temperature" | "topP" | "topK" | "idSlot" | "cachePrompt" | "nKeep" | "reasoningFormat"
  >,
): ChatRequestBody {
  return {
    messages: messages.map((message) => ({ ...message })),
    stream: true,
    stream_options: { include_usage: true },
    temperature: opts.temperature,
    top_p: opts.topP,
    top_k: opts.topK,
    id_slot: opts.idSlot ?? 0,
    cache_prompt: opts.cachePrompt ?? true,
    n_keep: opts.nKeep ?? 0,
    reasoning_format: opts.reasoningFormat ?? "auto",
  };
}

// POST /v1/chat/completions with stream:true; invokes onToken per delta.
// Resolves with token usage so the context meter stays live. Aborting the
// signal closes the connection, which makes llama-server cancel the task
// and release the slot (it polls req.should_stop while waiting).
export async function streamChat(
  baseUrl: string,
  opts: StreamChatOptions,
  onToken: (token: string) => void,
): Promise<ChatUsage> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildChatRequestBody(opts.messages, opts)),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat completions -> ${res.status}`);
  }
  const decoder = new TextDecoder();
  let buf = "";
  const usage: ChatUsage = { text: "", reasoning: "" };
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const ev of events) {
      for (const line of ev.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = parseChatChunkEvent(JSON.parse(data));
          for (const thought of parsed.reasoning) {
            usage.reasoning += thought;
            if (usage.ttftMs === undefined) usage.ttftMs = now() - startedAt;
            opts.onReasoning?.(thought);
          }
          for (const text of parsed.texts) {
            usage.text += text;
            if (usage.ttftMs === undefined) usage.ttftMs = now() - startedAt;
            usage.thoughtMs = now() - startedAt;
            onToken(text);
          }
          if (parsed.promptTokens !== undefined) usage.promptTokens = parsed.promptTokens;
          if (parsed.completionTokens !== undefined) {
            usage.completionTokens = parsed.completionTokens;
          }
          if (parsed.finishReason !== undefined) usage.finishReason = parsed.finishReason;
          if (parsed.timings !== undefined) usage.timings = parsed.timings;
        } catch {
          // keep-alive or partial frame; ignore
        }
      }
    }
  }
  return usage;
}
