import { describe, expect, it } from "vitest";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";

import { evaluateArithmetic } from "./calculate.js";

import { registerBuiltinTools } from "./index.js";

describe("Built-in Echo Tool", () => {
  it("echoes valid text payload", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("echo", { text: "Hello Aegis" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ text: "Hello Aegis" });
  });

  it("rejects input without required text property", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("echo", {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });

  it("rejects non-string text property", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("echo", { text: 12345 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });
});

describe("Built-in Calculate Tool & Zero-Eval Parser", () => {
  it("evaluates basic arithmetic expressions correctly", () => {
    expect(evaluateArithmetic("2 + 2")).toBe(4);
    expect(evaluateArithmetic("10 - 4")).toBe(6);
    expect(evaluateArithmetic("3 * 5")).toBe(15);
    expect(evaluateArithmetic("20 / 4")).toBe(5);
  });

  it("enforces operator precedence and parentheses", () => {
    expect(evaluateArithmetic("2 + 3 * 4")).toBe(14);
    expect(evaluateArithmetic("(2 + 3) * 4")).toBe(20);
    expect(evaluateArithmetic("100 / (5 + 5) * 2")).toBe(20);
    expect(evaluateArithmetic("((2 + 2) * (3 + 3)) / 4")).toBe(6);
  });

  it("handles floating point decimals and unary minus", () => {
    expect(evaluateArithmetic("1.5 * 2")).toBe(3);
    expect(evaluateArithmetic("-5 + 12")).toBe(7);
    expect(evaluateArithmetic("10 + -3")).toBe(7);
    expect(evaluateArithmetic("-2.5 * -4")).toBe(10);
  });

  it("rejects division by zero with a clean error", () => {
    expect(() => evaluateArithmetic("10 / 0")).toThrow("Division by zero");
    expect(() => evaluateArithmetic("5 / (2 - 2)")).toThrow("Division by zero");
  });

  it("rejects unbalanced parentheses and empty expressions", () => {
    expect(() => evaluateArithmetic("")).toThrow("Empty expression");
    expect(() => evaluateArithmetic("(2 + 3")).toThrow("Missing closing parenthesis");
    expect(() => evaluateArithmetic("2 + 3)")).toThrow("Unexpected token");
  });

  it("executes valid calculations through ToolExecutor", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("calculate", {
      expression: "(10 + 2) * 5 - 4 / 2",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 58 });
  });

  it("returns execution failure on division by zero", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("calculate", { expression: "100 / 0" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.error?.message).toContain("Division by zero");
  });

  it("rejects non-arithmetic characters and malicious code injections", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const maliciousExpressions = [
      "process.exit(1)",
      "require('node:fs')",
      "Function('return 1')()",
      "eval('2+2')",
      "console.log('pwn')",
      "this.constructor",
      "globalThis",
      "2 + x",
      "alert(1)",
    ];

    for (const expr of maliciousExpressions) {
      const result = await executor.execute("calculate", { expression: expr });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
      expect(result.error?.message).toContain("Unsafe or invalid characters");
    }
  });

  it("rejects invalid input schema (missing expression string)", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("calculate", {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_INPUT");
  });
});

describe("Built-in Noop Tool", () => {
  it("executes noop and returns confirmation", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("noop", {});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ noop: true });
  });
});

describe("registerBuiltinTools Helper", () => {
  it("registers all 3 safe built-in tools into a fresh registry", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.has("echo")).toBe(true);
    expect(registry.has("calculate")).toBe(true);
    expect(registry.has("noop")).toBe(true);

    const tools = registry.list();
    expect(tools.map((t) => t.name)).toEqual(["calculate", "echo", "noop"]);
  });
});
