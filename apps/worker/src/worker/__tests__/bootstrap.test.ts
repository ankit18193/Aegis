import { loadWorkerConfig } from "@aegis/config";
import { describe, expect, it } from "vitest";

import { createWorkerFromConfig } from "../bootstrap.js";

describe("createWorkerFromConfig (Phase 11A — Commit 3)", () => {
  it("initializes a valid WorkerRuntime using loaded WorkerConfig", () => {
    const config = loadWorkerConfig({
      WORKER_ID: "worker-bootstrap-10",
      WORKER_NAME: "Bootstrap Worker",
      WORKER_MAX_CONCURRENCY: "5",
      WORKER_TASK_TYPES: "execution,validation",
      WORKER_TOOLS: "echo",
    });

    const runtime = createWorkerFromConfig({ config });

    expect(runtime.getState()).toBe("starting");
    expect(runtime.isRunning).toBe(false);

    const identity = runtime.getIdentity();
    expect(identity.id).toBe("worker-bootstrap-10");
    expect(identity.name).toBe("Bootstrap Worker");
    expect(identity.capabilities.maxConcurrency).toBe(5);
    expect(identity.capabilities.taskTypes).toEqual(["execution", "validation"]);
    expect(identity.capabilities.tools).toEqual(["echo"]);
  });

  it("handles default WorkerConfig with generated IDs", () => {
    const config = loadWorkerConfig({});
    const runtime = createWorkerFromConfig({ config });

    expect(runtime.getIdentity().id).toBeDefined();
    expect(runtime.getIdentity().name).toBe("aegis-worker-1");
    expect(runtime.getIdentity().capabilities.maxConcurrency).toBe(1);
    expect(runtime.getIdentity().capabilities.taskTypes).toEqual(["*"]);
  });
});
