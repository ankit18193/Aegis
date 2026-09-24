import {
  getNodeEnv,
  loadAgentConfig,
  loadDatabaseConfig,
  loadKafkaConfig,
  type AgentConfig,
  type DatabaseConfig,
  type KafkaConfig,
  type NodeEnv,
  optionalEnv,
} from "@aegis/config";

import { validateMcpServerConfigs } from "../mcp/config.js";
import type { McpServerConfig } from "../mcp/types.js";

export interface ApiServerConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigin: string;
  readonly nodeEnv: NodeEnv;
  readonly logLevel: string;
  readonly database: DatabaseConfig;
  readonly agent: AgentConfig;
  readonly kafka: KafkaConfig;
  readonly mcpServers: readonly McpServerConfig[];
}

export function loadMcpConfig(): readonly McpServerConfig[] {
  const raw = optionalEnv("AEGIS_MCP_SERVERS", "");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const res = validateMcpServerConfigs(parsed);
      if (res.ok) {
        return res.value;
      }
    }
  } catch {
    // Ignore unparseable JSON in env
  }
  return [];
}

export function loadApiConfig(): ApiServerConfig {
  const portStr = optionalEnv("PORT", "3001");
  const port = parseInt(portStr, 10);

  return {
    port: Number.isNaN(port) ? 3001 : port,
    host: optionalEnv("HOST", "0.0.0.0"),
    corsOrigin: optionalEnv("CORS_ORIGIN", "http://localhost:3000"),
    nodeEnv: getNodeEnv(),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    database: loadDatabaseConfig(),
    agent: loadAgentConfig(),
    kafka: loadKafkaConfig(),
    mcpServers: loadMcpConfig(),
  };
}

