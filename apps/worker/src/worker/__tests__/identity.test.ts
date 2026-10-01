import { workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { createWorkerIdentity } from "../identity.js";

describe("createWorkerIdentity (Phase 11A — Commit 2)", () => {
  it("generates unique WorkerId and valid defaults when no options provided", () => {
    const id1 = createWorkerIdentity();
    const id2 = createWorkerIdentity();

    expect(id1.id).toBeDefined();
    expect(id2.id).toBeDefined();
    expect(id1.id).not.toBe(id2.id);

    expect(id1.id).toMatch(/^worker-[0-9a-f-]+/);
    expect(id1.name).toContain("worker-");
    expect(id1.capabilities.taskTypes).toEqual(["*"]);
    expect(id1.capabilities.tools).toEqual([]);
    expect(id1.capabilities.maxConcurrency).toBe(1);
    expect(new Date(id1.startedAt).getTime()).toBeGreaterThan(0);
  });

  it("respects explicit identity overrides", () => {
    const customId = workerId("worker-dedicated-55");
    const customDate = "2026-10-01T23:00:00.000Z";

    const identity = createWorkerIdentity({
      id: customId,
      name: "Dedicated Analysis Worker",
      startedAt: customDate,
      capabilities: {
        taskTypes: ["code_analysis", "test_execution"],
        tools: ["ast_parser", "linter"],
        maxConcurrency: 8,
      },
    });

    expect(identity.id).toBe(customId);
    expect(identity.name).toBe("Dedicated Analysis Worker");
    expect(identity.startedAt).toBe(customDate);
    expect(identity.capabilities.taskTypes).toEqual(["code_analysis", "test_execution"]);
    expect(identity.capabilities.tools).toEqual(["ast_parser", "linter"]);
    expect(identity.capabilities.maxConcurrency).toBe(8);
  });
});
