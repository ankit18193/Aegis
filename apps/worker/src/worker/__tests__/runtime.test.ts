import type { Logger } from "@aegis/logger";
import { describe, expect, it, vi } from "vitest";

import { createWorkerIdentity } from "../identity.js";
import { WorkerRuntime } from "../runtime.js";

describe("WorkerRuntime (Phase 11A — Commit 2)", () => {
  it("initializes with starting state and correct identity", () => {
    const identity = createWorkerIdentity({ name: "AlphaWorker" });
    const runtime = new WorkerRuntime({ identity });

    expect(runtime.getState()).toBe("starting");
    expect(runtime.isRunning).toBe(false);
    expect(runtime.getIdentity().name).toBe("AlphaWorker");
  });

  it("transitions starting -> ready upon start()", async () => {
    const runtime = new WorkerRuntime();
    const result = await runtime.start();

    expect(result.ok).toBe(true);
    expect(runtime.getState()).toBe("ready");
    expect(runtime.isRunning).toBe(true);
  });

  it("rejects duplicate start() call with WORKER_ALREADY_STARTED", async () => {
    const runtime = new WorkerRuntime();
    await runtime.start();

    const secondStart = await runtime.start();
    expect(secondStart.ok).toBe(false);
    if (!secondStart.ok) {
      expect(secondStart.error.code).toBe("WORKER_ALREADY_STARTED");
    }
    expect(runtime.getState()).toBe("ready");
  });

  it("transitions ready -> draining -> stopped upon stop()", async () => {
    const stateSequence: string[] = [];
    const infoSpy = vi.fn();
    const mockLogger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const runtime = new WorkerRuntime({
      logger: mockLogger,
      onStop: () => {
        stateSequence.push(runtime.getState());
      },
    });

    await runtime.start();
    expect(runtime.getState()).toBe("ready");

    const stopResult = await runtime.stop();
    expect(stopResult.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
    expect(runtime.isRunning).toBe(false);

    // During onStop callback, state must have been draining
    expect(stateSequence).toEqual(["draining"]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Worker runtime draining resources"),
      expect.any(Object),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Worker runtime stopped cleanly"),
      expect.any(Object),
    );
  });

  it("stop() is idempotent on an already stopped worker", async () => {
    const runtime = new WorkerRuntime();
    await runtime.start();
    await runtime.stop();
    expect(runtime.getState()).toBe("stopped");

    // Second stop
    const secondStop = await runtime.stop();
    expect(secondStop.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
  });

  it("transitions to failed when onStart throws and returns WORKER_START_FAILED", async () => {
    const errorSpy = vi.fn();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: errorSpy,
      debug: vi.fn(),
    } as unknown as Logger;

    const runtime = new WorkerRuntime({
      logger: mockLogger,
      onStart: () => {
        throw new Error("Failed to allocate local workspace directory");
      },
    });

    const result = await runtime.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WORKER_START_FAILED");
      expect(result.error.message).toContain("Failed to allocate local workspace directory");
    }

    expect(runtime.getState()).toBe("failed");
    expect(runtime.isRunning).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Worker runtime startup failed"),
      expect.any(Object),
    );

    // Stopping a failed worker transitions cleanly to stopped
    const stopResult = await runtime.stop();
    expect(stopResult.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
  });

  it("stops cleanly when worker is still in starting state", async () => {
    const runtime = new WorkerRuntime();
    expect(runtime.getState()).toBe("starting");

    const stopResult = await runtime.stop();
    expect(stopResult.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
  });

  it("cannot start a worker once stopped", async () => {
    const runtime = new WorkerRuntime();
    await runtime.start();
    await runtime.stop();

    const restartResult = await runtime.start();
    expect(restartResult.ok).toBe(false);
    if (!restartResult.ok) {
      expect(restartResult.error.code).toBe("WORKER_INVALID_STATE");
    }
  });

  it("handles concurrent stop calls cleanly without race conditions", async () => {
    let stopHookCallCount = 0;
    const runtime = new WorkerRuntime({
      onStop: async () => {
        stopHookCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    await runtime.start();
    expect(runtime.getState()).toBe("ready");

    // Launch multiple concurrent stop calls
    const [res1, res2, res3] = await Promise.all([
      runtime.stop(),
      runtime.stop(),
      runtime.stop(),
    ]);

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res3.ok).toBe(true);
    expect(stopHookCallCount).toBe(1);
    expect(runtime.getState()).toBe("stopped");
  });
});

