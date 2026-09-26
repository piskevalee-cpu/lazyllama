// Idempotent application shutdown: stop the managed server first, then
// destroy the UI, then exit. Pure dependency injection keeps this testable
// without spawning servers or touching the real process object.

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ShutdownDeps {
  stopServer: () => Promise<void>;
  destroyUi: () => void;
  exit: (code: number) => void;
  onSignal: (signal: ShutdownSignal, handler: () => void) => void;
  offSignal: (signal: ShutdownSignal, handler: () => void) => void;
}

export const SHUTDOWN_SIGNALS: ShutdownSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface ShutdownController {
  shutdown: () => void;
  isShuttingDown: () => boolean;
}

export function createShutdown(deps: ShutdownDeps): ShutdownController {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const signal of SHUTDOWN_SIGNALS) deps.offSignal(signal, shutdown);
    void (async () => {
      try {
        await deps.stopServer();
      } finally {
        try {
          deps.destroyUi();
        } finally {
          deps.exit(0);
        }
      }
    })();
  };
  for (const signal of SHUTDOWN_SIGNALS) deps.onSignal(signal, shutdown);
  return { shutdown, isShuttingDown: () => shuttingDown };
}
