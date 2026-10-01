import type { Logger } from "@aegis/logger";
import { describe, expect, it, vi } from "vitest";

import { runWorkerProcess } from "../runner.js";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => createMockLogger(),
  } as unknown as Logger;
}

describe("runWorkerProcess (Phase 11A — Commit 4)", () => {
  it("starts the worker runtime to ready state and provides shutdown handle", async () => {
    const logger = createMockLogger();
    const onExit = vi.fn();

    const handle = await runWorkerProcess({
      env: {
        WORKER_ID: "worker-proc-1",
        WORKER_NAME: "Process Test Worker",
        WORKER_MAX_CONCURRENCY: "3",
      },
      logger,
      registerSignalHandlers: false,
      onExit,
    });

    expect(handle.runtime.getState()).toBe("ready");
    expect(handle.runtime.isRunning).toBe(true);
    expect(handle.runtime.getIdentity().id).toBe("worker-proc-1");
    expect(handle.runtime.getIdentity().name).toBe("Process Test Worker");

    // Perform graceful shutdown
    const exitCode = await handle.shutdown("TEST_SIGNAL");
    expect(exitCode).toBe(0);
    expect(handle.runtime.getState()).toBe("stopped");
    expect(handle.runtime.isRunning).toBe(false);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("handles duplicate shutdown calls idempotently", async () => {
    const logger = createMockLogger();
    const onExit = vi.fn();

    const handle = await runWorkerProcess({
      logger,
      registerSignalHandlers: false,
      onExit,
    });

    const firstExit = await handle.shutdown();
    const secondExit = await handle.shutdown();

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("registers and responds to process signals when enabled", async () => {
    const logger = createMockLogger();
    const onExit = vi.fn();

    const handle = await runWorkerProcess({
      logger,
      registerSignalHandlers: true,
      onExit,
    });

    expect(handle.runtime.getState()).toBe("ready");

    // Emit SIGINT to simulate Ctrl+C
    process.emit("SIGINT");

    // Wait a brief tick for async signal handler to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handle.runtime.getState()).toBe("stopped");
    expect(onExit).toHaveBeenCalledWith(0);
  });
});
