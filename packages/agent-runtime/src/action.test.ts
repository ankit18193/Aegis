import { describe, expect, it } from "vitest";

import { DefaultActionExecutor } from "./action.js";

describe("DefaultActionExecutor", () => {
  const executor = new DefaultActionExecutor();

  it("executes 'echo' action successfully", async () => {
    const result = await executor.execute({
      name: "echo",
      payload: { text: "Aegis runtime active" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.actionName).toBe("echo");
    expect(result.value.success).toBe(true);
    expect(result.value.data).toEqual({ echoed: "Aegis runtime active" });
    expect(result.value.error).toBeUndefined();
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.value.timestamp).toBeDefined();
  });

  it("executes 'noop' action successfully", async () => {
    const result = await executor.execute({
      name: "noop",
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.actionName).toBe("noop");
    expect(result.value.success).toBe(true);
    expect(result.value.data).toEqual({ noop: true });
  });

  it("executes 'calculate' action for valid arithmetic", async () => {
    const result = await executor.execute({
      name: "calculate",
      payload: { expression: "(10 + 5) * 2 - 4 / 2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.actionName).toBe("calculate");
    expect(result.value.success).toBe(true);
    expect(result.value.data).toEqual({ result: 28 });
  });

  it("rejects 'calculate' with unsafe characters as structured observation failure", async () => {
    const result = await executor.execute({
      name: "calculate",
      payload: { expression: "process.exit(1)" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.actionName).toBe("calculate");
    expect(result.value.success).toBe(false);
    expect(result.value.error).toContain("Unsafe characters detected");
  });

  it("rejects 'calculate' with missing expression string", async () => {
    const result = await executor.execute({
      name: "calculate",
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.success).toBe(false);
    expect(result.value.error).toContain("Payload must contain a non-empty 'expression'");
  });

  it("handles unrecognized actions as structured observation failure", async () => {
    const result = await executor.execute({
      name: "unknown_tool",
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.actionName).toBe("unknown_tool");
    expect(result.value.success).toBe(false);
    expect(result.value.error).toContain("Unrecognized action 'unknown_tool'");
  });
});
