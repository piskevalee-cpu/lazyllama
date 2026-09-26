import { describe, expect, test } from "bun:test";
import { createShutdown, SHUTDOWN_SIGNALS, type ShutdownSignal } from "../src/shutdown.ts";

function fakeProcess() {
  const handlers = new Map<ShutdownSignal, Set<() => void>>();
  return {
    on: (signal: ShutdownSignal, handler: () => void) => {
      if (!handlers.has(signal)) handlers.set(signal, new Set());
      handlers.get(signal)!.add(handler);
    },
    off: (signal: ShutdownSignal, handler: () => void) => {
      handlers.get(signal)?.delete(handler);
    },
    emit: (signal: ShutdownSignal) => {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler();
    },
    count: (signal: ShutdownSignal) => handlers.get(signal)?.size ?? 0,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("application shutdown", () => {
  test("registers window-close and quit signals", () => {
    const proc = fakeProcess();
    createShutdown({
      stopServer: async () => {},
      destroyUi: () => {},
      exit: () => {},
      onSignal: proc.on,
      offSignal: proc.off,
    });
    for (const signal of SHUTDOWN_SIGNALS) expect(proc.count(signal)).toBe(1);
    expect(SHUTDOWN_SIGNALS).toContain("SIGHUP");
  });

  test("stops the server before destroying the UI and exiting", async () => {
    const proc = fakeProcess();
    const calls: string[] = [];
    const controller = createShutdown({
      stopServer: async () => {
        calls.push("stop");
      },
      destroyUi: () => {
        calls.push("destroy");
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
      onSignal: proc.on,
      offSignal: proc.off,
    });
    controller.shutdown();
    await settle();
    expect(calls).toEqual(["stop", "destroy", "exit:0"]);
    expect(controller.isShuttingDown()).toBe(true);
  });

  test("shutdown runs once and unregisters every signal", async () => {
    const proc = fakeProcess();
    let stops = 0;
    const controller = createShutdown({
      stopServer: async () => {
        stops += 1;
      },
      destroyUi: () => {},
      exit: () => {},
      onSignal: proc.on,
      offSignal: proc.off,
    });
    proc.emit("SIGHUP");
    proc.emit("SIGINT");
    controller.shutdown();
    await settle();
    expect(stops).toBe(1);
    for (const signal of SHUTDOWN_SIGNALS) expect(proc.count(signal)).toBe(0);
  });
});
