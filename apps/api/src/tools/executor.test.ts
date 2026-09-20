import { err, ok } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ConfigurableAuthorizationPolicy } from "./authorization.js";
import { ToolError } from "./errors.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { isSensitiveKey, sanitizePayload } from "./safety.js";
import type { Tool } from "./tool.js";

describe("ToolExecutor & Validation Pipeline", () => {
  it("returns TOOL_NOT_FOUND when tool is not registered", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    const result = await executor.execute("unregistered", { any: "data" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(result.error?.message).toContain("unregistered");
  });

  it("validates input schema and halts execution before invoking tool on invalid input", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn().mockResolvedValue(ok({ echoed: "test" }));

    const strictTool: Tool<{ text: string }> = {
      name: "strict_echo",
      description: "Requires string text",
      inputSchema: z.object({ text: z.string().min(3) }),
      execute: executeSpy,
    };
    registry.register(strictTool as Tool);

    const executor = new ToolExecutor(registry);

    // 1. Invalid input: missing field
    const res1 = await executor.execute("strict_echo", {});
    expect(res1.success).toBe(false);
    expect(res1.error?.code).toBe("INVALID_TOOL_INPUT");
    expect(executeSpy).not.toHaveBeenCalled();

    // 2. Invalid input: wrong type
    const res2 = await executor.execute("strict_echo", { text: 1234 });
    expect(res2.success).toBe(false);
    expect(res2.error?.code).toBe("INVALID_TOOL_INPUT");
    expect(executeSpy).not.toHaveBeenCalled();

    // 3. Invalid input: too short
    const res3 = await executor.execute("strict_echo", { text: "ab" });
    expect(res3.success).toBe(false);
    expect(res3.error?.code).toBe("INVALID_TOOL_INPUT");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("checks authorization and halts execution when tool is denied by policy", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn().mockResolvedValue(ok({ status: "done" }));

    const sensitiveTool: Tool = {
      name: "restricted_admin",
      description: "Restricted tool",
      inputSchema: z.object({ code: z.string() }),
      execute: executeSpy,
    };
    registry.register(sensitiveTool);

    const policy = new ConfigurableAuthorizationPolicy({
      deniedTools: ["restricted_admin"],
    });
    const executor = new ToolExecutor(registry, policy);

    const result = await executor.execute("restricted_admin", { code: "admin" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNAUTHORIZED_TOOL");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("executes authorized tool with valid input and measures durationMs", async () => {
    const registry = new ToolRegistry();
    const tool: Tool<{ text: string }> = {
      name: "valid_tool",
      description: "A valid tool",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      execute: async (input) => {
        await new Promise((r) => setTimeout(r, 10));
        return ok({ echoed: input.text });
      },
    };
    registry.register(tool as Tool);

    const executor = new ToolExecutor(registry);
    const result = await executor.execute("valid_tool", { text: "hello world" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echoed: "hello world" });
    expect(result.durationMs).toBeGreaterThanOrEqual(5);
  });

  it("handles tool execution failure returned as Result.err", async () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "failing_tool",
      description: "Always fails",
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return err(ToolError.executionFailed("failing_tool", "Operation failed explicitly"));
      },
    };
    registry.register(tool);

    const executor = new ToolExecutor(registry);
    const result = await executor.execute("failing_tool", {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.error?.message).toContain("Operation failed explicitly");
  });

  it("catches unhandled exceptions thrown by tool and maps to TOOL_EXECUTION_FAILED", async () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "throwing_tool",
      description: "Throws unhandled exception",
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        throw new Error("Unexpected crash inside tool logic");
      },
    };
    registry.register(tool);

    const executor = new ToolExecutor(registry);
    const result = await executor.execute("throwing_tool", {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.error?.message).toContain("Unexpected crash inside tool logic");
  });

  it("validates output schema and returns INVALID_TOOL_OUTPUT when output does not match", async () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "corrupt_output_tool",
      description: "Returns wrong output type",
      inputSchema: z.object({}),
      outputSchema: z.object({ expectedNumber: z.number() }),
      execute: async () => {
        await Promise.resolve();
        return ok({ expectedNumber: "not-a-number" as unknown as number });
      },
    };
    registry.register(tool);

    const executor = new ToolExecutor(registry);
    const result = await executor.execute("corrupt_output_tool", {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TOOL_OUTPUT");
    expect(result.error?.message).toContain("Output validation failed");
  });

  it("halts execution if abort signal is already cancelled", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn().mockResolvedValue(ok({}));
    const tool: Tool = {
      name: "abortable",
      description: "Abortable tool",
      inputSchema: z.object({}),
      execute: executeSpy,
    };
    registry.register(tool);

    const executor = new ToolExecutor(registry);
    const controller = new AbortController();
    controller.abort("User cancelled before tool start");

    const result = await executor.execute("abortable", {}, {
      toolName: "abortable",
      abortSignal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("User cancelled before tool start");
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("Event Payload Hygiene & Sanitization", () => {
  it("identifies sensitive keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("secretKey")).toBe(true);
    expect(isSensitiveKey("userCredential")).toBe(true);
    expect(isSensitiveKey("username")).toBe(false);
    expect(isSensitiveKey("text")).toBe(false);
  });

  it("recursively redacts sensitive keys while preserving safe fields", () => {
    const raw = {
      username: "alice",
      token: "secret-token-1234",
      config: {
        timeout: 5000,
        apiKey: "ak-999-super-secret",
        nested: {
          password: "my-password",
          status: "active",
        },
      },
      tags: ["dev", "test"],
    };

    const sanitized = sanitizePayload(raw);

    expect(sanitized).toEqual({
      username: "alice",
      token: "[REDACTED]",
      config: {
        timeout: 5000,
        apiKey: "[REDACTED]",
        nested: {
          password: "[REDACTED]",
          status: "active",
        },
      },
      tags: ["dev", "test"],
    });

    // Original raw object is NOT mutated
    expect(raw.token).toBe("secret-token-1234");
    expect(raw.config.apiKey).toBe("ak-999-super-secret");
    expect(raw.config.nested.password).toBe("my-password");
  });

  it("safely handles circular references without throwing stack overflow", () => {
    interface CircularObj {
      name: string;
      self?: CircularObj;
    }
    const circular: CircularObj = { name: "circular-root" };
    circular.self = circular;

    const sanitized = sanitizePayload(circular);
    expect(sanitized.name).toBe("circular-root");
    expect(sanitized.self).toBe("[CIRCULAR]");
  });
});
