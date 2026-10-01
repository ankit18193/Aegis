import { describe, expect, it } from "vitest";

import { WorkerLifecycleManager } from "../state.js";

describe("WorkerLifecycleManager (Phase 11A — Commit 2)", () => {
  it("initializes with starting state by default", () => {
    const manager = new WorkerLifecycleManager();
    expect(manager.getState()).toBe("starting");
  });

  it("supports initializing with an explicit state", () => {
    const manager = new WorkerLifecycleManager("ready");
    expect(manager.getState()).toBe("ready");
  });

  it("executes valid full lifecycle: starting -> ready -> draining -> stopped", () => {
    const manager = new WorkerLifecycleManager();

    const toReady = manager.transitionTo("ready");
    expect(toReady.ok).toBe(true);
    expect(manager.getState()).toBe("ready");

    const toDraining = manager.transitionTo("draining");
    expect(toDraining.ok).toBe(true);
    expect(manager.getState()).toBe("draining");

    const toStopped = manager.transitionTo("stopped");
    expect(toStopped.ok).toBe(true);
    expect(manager.getState()).toBe("stopped");
  });

  it("executes failure lifecycle: starting -> failed -> stopped", () => {
    const manager = new WorkerLifecycleManager();

    const toFailed = manager.transitionTo("failed");
    expect(toFailed.ok).toBe(true);
    expect(manager.getState()).toBe("failed");

    const toStopped = manager.transitionTo("stopped");
    expect(toStopped.ok).toBe(true);
    expect(manager.getState()).toBe("stopped");
  });

  it("allows starting worker to stop directly", () => {
    const manager = new WorkerLifecycleManager();

    const toStopped = manager.transitionTo("stopped");
    expect(toStopped.ok).toBe(true);
    expect(manager.getState()).toBe("stopped");
  });

  it("rejects transition to the identical state with WORKER_INVALID_STATE", () => {
    const manager = new WorkerLifecycleManager("starting");
    const result = manager.transitionTo("starting");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WORKER_INVALID_STATE");
      expect(result.error.message).toContain("already in state 'starting'");
    }
  });

  it("rejects illegal transitions with structured WORKER_INVALID_STATE", () => {
    const manager = new WorkerLifecycleManager("ready");

    // ready -> starting (illegal)
    const backwards = manager.transitionTo("starting");
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) {
      expect(backwards.error.code).toBe("WORKER_INVALID_STATE");
      expect(backwards.error.message).toContain("cannot transition from 'ready' to 'starting'");
    }

    // ready -> stopped (illegal without draining)
    const directStop = manager.transitionTo("stopped");
    expect(directStop.ok).toBe(false);
    if (!directStop.ok) {
      expect(directStop.error.code).toBe("WORKER_INVALID_STATE");
    }
  });

  it("prevents any transitions out of stopped terminal state", () => {
    const manager = new WorkerLifecycleManager("stopped");

    expect(manager.transitionTo("starting").ok).toBe(false);
    expect(manager.transitionTo("ready").ok).toBe(false);
    expect(manager.transitionTo("draining").ok).toBe(false);
    expect(manager.transitionTo("failed").ok).toBe(false);
  });
});
