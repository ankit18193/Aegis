/**
 * MCP Tool Adapter connecting external MCP tools into the Aegis Tool System.
 * Conforms to the Phase 7 Tool<TInput, TOutput> contract.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import { z } from "zod";

import type { ToolError } from "../tools/errors.js";
import type { Tool, ToolExecutionContext } from "../tools/tool.js";
import { isValidToolName } from "../tools/tool.js";

import { McpError, toMcpError } from "./errors.js";
import { jsonSchemaToZod } from "./schema.js";
import type { IMcpClient, McpContent, McpTextContent, McpToolDefinition } from "./types.js";

/**
 * Deterministic MCP tool naming utility.
 * Always formats as `mcp_${serverId}_${toolName}` using server ID (not display name).
 */
export function generateMcpToolName(serverId: string, rawToolName: string): string {
  return `mcp_${serverId}_${rawToolName}`;
}

export interface FormattedMcpOutput {
  readonly text?: string | undefined;
  readonly content: readonly McpContent[];
}

export const formattedMcpOutputSchema: z.ZodType<FormattedMcpOutput> = z.object({
  text: z.string().optional(),
  content: z.array(z.custom<McpContent>()),
});

/**
 * Formats and normalizes raw MCP content items into a deterministic Aegis output object.
 */
export function formatMcpContent(content: readonly McpContent[]): FormattedMcpOutput {
  const textParts = content
    .filter((c): c is McpTextContent => c.type === "text" && typeof (c as McpTextContent).text === "string")
    .map((c) => c.text);

  const text = textParts.length > 0 ? textParts.join("\n") : undefined;

  return {
    text,
    content,
  };
}

/**
 * Adapter wrapping an external MCP tool definition into a first-class Aegis Tool.
 */
export class McpToolAdapter implements Tool<unknown, FormattedMcpOutput> {
  readonly name: string;
  readonly description: string;
  readonly serverId: string;
  readonly rawToolName: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<FormattedMcpOutput> = formattedMcpOutputSchema;
  private readonly client: IMcpClient;

  private constructor(
    name: string,
    description: string,
    serverId: string,
    rawToolName: string,
    inputSchema: z.ZodType<unknown>,
    client: IMcpClient,
  ) {
    this.name = name;
    this.description = description;
    this.serverId = serverId;
    this.rawToolName = rawToolName;
    this.inputSchema = inputSchema;
    this.client = client;
  }

  /**
   * Factory creating an McpToolAdapter from an MCP tool definition and verifying all contracts:
   * - Canonical naming (mcp_${serverId}_${toolName})
   * - Full regex validation against TOOL_NAME_REGEX
   * - JSON Schema translation to Zod
   */
  static create(
    serverId: string,
    toolDef: McpToolDefinition,
    client: IMcpClient,
  ): Result<McpToolAdapter, McpError> {
    const canonicalName = generateMcpToolName(serverId, toolDef.name);

    if (!isValidToolName(canonicalName)) {
      return err(
        McpError.invalidConfig(
          serverId,
          `Generated tool name '${canonicalName}' violates TOOL_NAME_REGEX ('^[a-z][a-z0-9_-]{0,63}$').`,
        ),
      );
    }

    const schemaRes = jsonSchemaToZod(toolDef.inputSchema, canonicalName);
    if (!schemaRes.ok) {
      return schemaRes;
    }

    const adapter = new McpToolAdapter(
      canonicalName,
      toolDef.description ?? `MCP tool '${toolDef.name}' from server '${serverId}'`,
      serverId,
      toolDef.name,
      schemaRes.value,
      client,
    );

    return ok(adapter);
  }

  execute = async (
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<Result<FormattedMcpOutput, ToolError>> => {
    try {
      const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const callResult = await this.client.callTool(this.rawToolName, args, {
        abortSignal: context.abortSignal,
      });

      const formatted = formatMcpContent(callResult.content);

      if (callResult.isError) {
        return err(
          toMcpError(
            formatted.text ?? `MCP tool '${this.name}' execution failed on server`,
            this.serverId,
            this.name,
          ).toToolError(),
        );
      }

      return ok(formatted);
    } catch (error) {
      if (error instanceof McpError) {
        return err(error.toToolError());
      }
      return err(toMcpError(error, this.serverId, this.name).toToolError());
    }
  }
}
