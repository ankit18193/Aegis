/**
 * Configuration schemas and validation for Aegis MCP Servers.
 * Enforces strict transport-specific requirements (stdio vs memory)
 * and server ID naming invariants.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import { z } from "zod";

import { McpError } from "./errors.js";
import type { McpServerConfig } from "./types.js";

/**
 * Server ID regex: must start with a lowercase letter, followed by lowercase alphanumeric,
 * underscores, or hyphens (max 32 characters).
 */
export const MCP_SERVER_ID_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidMcpServerId(id: string): boolean {
  return typeof id === "string" && MCP_SERVER_ID_REGEX.test(id);
}

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const MIN_MCP_TIMEOUT_MS = 100;
export const MAX_MCP_TIMEOUT_MS = 300_000;

const baseSchema = z.object({
  id: z
    .string({ required_error: "Server ID is required" })
    .regex(
      MCP_SERVER_ID_REGEX,
      "Server ID must match '^[a-z][a-z0-9_-]{0,31}$' (lowercase alphanumeric, underscores, hyphens, max 32 chars)",
    ),
  name: z.string({ required_error: "Server name is required" }).min(1, "Server name must be a non-empty string"),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_MCP_TIMEOUT_MS, `Timeout must be at least ${MIN_MCP_TIMEOUT_MS.toString()}ms`)
    .max(MAX_MCP_TIMEOUT_MS, `Timeout cannot exceed ${MAX_MCP_TIMEOUT_MS.toString()}ms`)
    .optional(),
  disabled: z.boolean().optional(),
});

const stdioSchema = baseSchema.extend({
  transport: z.literal("stdio"),
  command: z
    .string({ required_error: "Command is required for stdio transport" })
    .min(1, "Command is required for stdio transport"),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
});

const memorySchema = baseSchema.extend({
  transport: z.literal("memory"),
  command: z.undefined({ message: "command is not allowed for memory transport" }),
  args: z.undefined({ message: "args is not allowed for memory transport" }),
  env: z.undefined({ message: "env is not allowed for memory transport" }),
  cwd: z.undefined({ message: "cwd is not allowed for memory transport" }),
});

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  stdioSchema,
  memorySchema,
]);

/**
 * Validates an MCP server configuration object, ensuring transport-specific correctness
 * and returning a structured Result<McpServerConfig, McpError>.
 */
export function validateMcpServerConfig(config: unknown): Result<McpServerConfig, McpError> {
  const parseResult = mcpServerConfigSchema.safeParse(config);

  if (!parseResult.success) {
    const rawId =
      typeof config === "object" && config !== null && "id" in config && typeof config.id === "string"
        ? config.id
        : "unknown";

    const issueMessages = parseResult.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");

    return err(
      McpError.invalidConfig(rawId, issueMessages),
    );
  }

  const valid = parseResult.data;
  const normalized: McpServerConfig = {
    id: valid.id,
    name: valid.name,
    transport: valid.transport,
    command: valid.command,
    args: valid.args,
    env: valid.env,
    cwd: valid.cwd,
    timeoutMs: valid.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    disabled: valid.disabled ?? false,
  };

  return ok(normalized);
}

/**
 * Validates a collection of MCP server configurations and rejects any duplicate IDs.
 */
export function validateMcpServerConfigs(
  configs: readonly unknown[],
): Result<readonly McpServerConfig[], McpError> {
  const result: McpServerConfig[] = [];
  const seenIds = new Set<string>();

  for (const raw of configs) {
    const res = validateMcpServerConfig(raw);
    if (!res.ok) {
      return res;
    }
    const validated = res.value;
    if (seenIds.has(validated.id)) {
      return err(
        McpError.invalidConfig(validated.id, `Duplicate MCP server ID '${validated.id}' detected.`),
      );
    }
    seenIds.add(validated.id);
    result.push(validated);
  }

  return ok(result);
}
