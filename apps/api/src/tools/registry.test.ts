import { ok } from "@aegis/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolError } from "./errors.js";
import { ToolRegistry } from "./registry.js";
import { isValidToolName, type Tool } from "./tool.js";

function createMockTool(name: string, description = "Mock description"): Tool {
  return {
    name,
    description,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    execute: async (input: unknown) => {
      await Promise.resolve();
      return ok({ result: JSON.stringify(input) });
    },
  };
}

describe("Tool Naming Rules", () => {
  it("validates standard lowercase tool names", () => {
    expect(isValidToolName("echo")).toBe(true);
    expect(isValidToolName("calculate")).toBe(true);
    expect(isValidToolName("web_search")).toBe(true);
    expect(isValidToolName("data-fetch-01")).toBe(true);
    expect(isValidToolName("a")).toBe(true);
  });

  it("rejects invalid tool names", () => {
    expect(isValidToolName("")).toBe(false);
    expect(isValidToolName("Echo")).toBe(false);
    expect(isValidToolName("1echo")).toBe(false);
    expect(isValidToolName("echo tool")).toBe(false);
    expect(isValidToolName("echo/tool")).toBe(false);
    expect(isValidToolName("echo.tool")).toBe(false);
    expect(isValidToolName("echo$")).toBe(false);
    expect(isValidToolName("a".repeat(65))).toBe(false);
  });
});

describe("ToolRegistry", () => {
  it("registers a valid tool successfully", () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("echo");

    const result = registry.register(tool);
    expect(result.ok).toBe(true);
    expect(registry.has("echo")).toBe(true);
    expect(registry.get("echo")).toBe(tool);
  });

  it("rejects duplicate tool registrations with DUPLICATE_TOOL", () => {
    const registry = new ToolRegistry();
    const tool1 = createMockTool("echo", "First version");
    const tool2 = createMockTool("echo", "Second version");

    const first = registry.register(tool1);
    expect(first.ok).toBe(true);

    const second = registry.register(tool2);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(ToolError);
      expect(second.error.code).toBe("DUPLICATE_TOOL");
      expect(second.error.message).toContain("already registered");
    }

    // Original tool remains intact
    expect(registry.get("echo")?.description).toBe("First version");
  });

  it("rejects tools with invalid names", () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("InvalidName");

    const res = registry.register(tool);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_TOOL_DEFINITION");
    }
  });

  it("rejects tools with missing description or schema", () => {
    const registry = new ToolRegistry();

    const noDesc = {
      name: "valid_name",
      description: "",
      inputSchema: z.object({}),
      execute: async () => {
        await Promise.resolve();
        return ok({});
      },
    } as unknown as Tool;

    const noSchema = {
      name: "valid_name",
      description: "A description",
      inputSchema: undefined,
      execute: async () => {
        await Promise.resolve();
        return ok({});
      },
    } as unknown as Tool;

    expect(registry.register(noDesc).ok).toBe(false);
    expect(registry.register(noSchema).ok).toBe(false);
  });

  it("returns undefined and false for unregistered tool names", () => {
    const registry = new ToolRegistry();
    expect(registry.has("non_existent")).toBe(false);
    expect(registry.get("non_existent")).toBeUndefined();
  });

  it("returns a fresh array of tools sorted alphabetically", () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("zebra"));
    registry.register(createMockTool("apple"));
    registry.register(createMockTool("mango"));

    const list1 = registry.list();
    expect(list1.map((t) => t.name)).toEqual(["apple", "mango", "zebra"]);

    // External modification of returned array does not affect the registry
    (list1 as Tool[]).pop();
    expect(registry.list().map((t) => t.name)).toEqual(["apple", "mango", "zebra"]);
  });
});
