import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  ServerManager,
  assertServerPortFree,
  buildChatRequestBody,
  childStartError,
  parseChatChunkEvent,
  readNCtx,
  streamChat,
} from "../src/server.ts";

describe("server startup guards", () => {
  test("a healthy endpoint blocks a duplicate managed server", async () => {
    await expect(assertServerPortFree(async () => true, "http://127.0.0.1:8080")).rejects.toThrow(
      /already responding/,
    );
    await expect(
      assertServerPortFree(async () => false, "http://127.0.0.1:8080"),
    ).resolves.toBeUndefined();
  });

  test("a child that exits around readiness is reported instead of marked ready", () => {
    expect(childStartError(null, "http://127.0.0.1:8080")).toBeUndefined();
    expect(childStartError(1, "http://127.0.0.1:8080")?.message).toContain("exited early");
    const cause = new Error("address in use");
    expect(childStartError(1, "http://127.0.0.1:8080", cause)).toBe(cause);
  });

  test("streaming deltas and final message content are both captured", () => {
    expect(
      parseChatChunkEvent({ choices: [{ delta: { content: "hel" } }] }).texts,
    ).toEqual(["hel"]);
    expect(
      parseChatChunkEvent({ choices: [{ message: { content: "done" } }] }).texts,
    ).toEqual(["done"]);
    const finished = parseChatChunkEvent({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
    expect(finished.texts).toEqual([]);
    expect(finished.finishReason).toBe("stop");
    expect(finished.promptTokens).toBe(3);
    expect(finished.completionTokens).toBe(5);
    expect(parseChatChunkEvent(null).texts).toEqual([]);
    expect(parseChatChunkEvent({ choices: [{ delta: { content: "" } }] }).texts).toEqual([]);
  });

  test("server timings are captured for context and tok/s display", () => {
    const parsed = parseChatChunkEvent({
      choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      timings: { cache_n: 10, prompt_n: 4, predicted_n: 2, predicted_per_second: 25 },
    });
    expect(parsed.texts).toEqual(["hi"]);
    expect(parsed.timings).toEqual({
      cacheN: 10,
      promptN: 4,
      predictedN: 2,
      predictedPerSecond: 25,
    });
    expect(parseChatChunkEvent({ choices: [{}] }).timings).toBeUndefined();
    expect(parseChatChunkEvent({ timings: { prompt_n: "x" } }).timings).toBeUndefined();
  });

  test("chat requests pin one slot and reuse the prompt cache", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    const body = buildChatRequestBody(messages, {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      nKeep: 64,
    });
    expect(body.messages).toEqual(messages);
    expect(body.messages).not.toBe(messages);
    expect(body.stream).toBe(true);
    expect(body.id_slot).toBe(0);
    expect(body.cache_prompt).toBe(true);
    expect(body.n_keep).toBe(64);
    expect(body.temperature).toBe(0.7);
    expect(
      buildChatRequestBody(messages, { idSlot: 2, cachePrompt: false }).id_slot,
    ).toBe(2);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("reasoning is requested and thinking deltas are separated from content", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(buildChatRequestBody(messages, {}).reasoning_format).toBe("auto");
    expect(
      buildChatRequestBody(messages, { reasoningFormat: "none" }).reasoning_format,
    ).toBe("none");
    const streamed = parseChatChunkEvent({
      choices: [{ delta: { reasoning_content: "think" } }],
    });
    expect(streamed.reasoning).toEqual(["think"]);
    expect(streamed.texts).toEqual([]);
    const final = parseChatChunkEvent({
      choices: [{ message: { reasoning_content: "full thought", content: "answer" } }],
    });
    expect(final.reasoning).toEqual(["full thought"]);
    expect(final.texts).toEqual(["answer"]);
  });

  test("streamChat measures thought time and forwards thinking deltas", async () => {
    const events = [
      'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}',
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n\n");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new TextEncoder().encode(events), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const clock = [1000, 1200, 2400];
    let tick = 0;
    try {
      const thinking: string[] = [];
      const answer: string[] = [];
      const usage = await streamChat(
        "http://127.0.0.1:1",
        {
          messages: [{ role: "user", content: "hi" }],
          now: () => clock[Math.min(tick++, clock.length - 1)],
          onReasoning: (token) => thinking.push(token),
        },
        (token) => answer.push(token),
      );
      expect(thinking).toEqual(["pondering"]);
      expect(answer).toEqual(["answer"]);
      expect(usage.reasoning).toBe("pondering");
      expect(usage.finishReason).toBe("stop");
      // Request starts at 1000ms, first thinking token at 1200ms, first
      // content token at 2400ms: 200ms to first token, 1400ms of thought.
      expect(usage.ttftMs).toBe(200);
      expect(usage.thoughtMs).toBe(1400);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an aborted request rejects so the caller can mark it interrupted", async () => {
    const controller = new AbortController();
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    try {
      const pending = streamChat(
        "http://127.0.0.1:1",
        { messages: [{ role: "user", content: "hi" }], signal: controller.signal },
        () => {},
      );
      controller.abort();
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("context limit reads nested props before top-level", () => {
    expect(readNCtx({ n_ctx: 4096 })).toBe(4096);
    expect(readNCtx({ default_generation_settings: { n_ctx: 8192 } })).toBe(8192);
    expect(readNCtx({ default_generation_settings: {} })).toBeUndefined();
    expect(readNCtx({})).toBeUndefined();
    expect(readNCtx(undefined)).toBeUndefined();
  });

  test("stop terminates a running child process", async () => {
    const manager = new ServerManager([], "127.0.0.1", 0);
    const proc = spawn("sleep", ["60"], { stdio: "ignore" });
    (manager as unknown as { proc: ChildProcess | null }).proc = proc;
    expect(manager.running()).toBe(true);
    await manager.stop();
    expect(manager.running()).toBe(false);
    expect(proc.signalCode).toBe("SIGTERM");
  });
});
