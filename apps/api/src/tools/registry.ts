/**
 * Tool Registry for the Aegis Tool System.
 * Provides synchronous, in-process capability registration and deterministic retrieval.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { ToolError } from "./errors.js";
import { isValidToolName, type Tool } from "./tool.js";

export interface IToolRegistry {
  register(tool: Tool): Result<void, ToolError>;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  list(): readonly Tool[];
}

/**
 * Synchronous in-process registry with deterministic Map operations.
 * Registry internal Map remains private. External mutation is prohibited.
 */
export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): Result<void, ToolError> {
    const rawTool = tool as unknown;
    if (!rawTool || typeof rawTool !== "object") {
      return err(ToolError.invalidDefinition("unknown", "Tool must be an object."));
    }

    if (!isValidToolName(tool.name)) {
      return err(
        ToolError.invalidDefinition(
          tool.name,
          `Tool name must match pattern '^[a-z][a-z0-9_-]{0,63}$'. Received '${tool.name}'.`,
        ),
      );
    }

    if (!tool.description || typeof tool.description !== "string") {
      return err(
        ToolError.invalidDefinition(tool.name, "Tool must define a non-empty string description."),
      );
    }

    const rawInputSchema = tool.inputSchema as unknown;
    if (!rawInputSchema || typeof (rawInputSchema as { safeParse?: unknown }).safeParse !== "function") {
      return err(
        ToolError.invalidDefinition(tool.name, "Tool must define a valid Zod input schema."),
      );
    }

    if (typeof (rawTool as { execute?: unknown }).execute !== "function") {
      return err(ToolError.invalidDefinition(tool.name, "Tool must implement an execute function."));
    }

    if (this.tools.has(tool.name)) {
      return err(ToolError.duplicate(tool.name));
    }

    this.tools.set(tool.name, tool);
    return ok(undefined);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Returns a fresh, deterministic array of all registered tools,
   * sorted alphabetically by tool name.
   */
  list(): readonly Tool[] {
    const list = Array.from(this.tools.values());
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return list;
  }
}
