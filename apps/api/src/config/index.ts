import { getNodeEnv, type NodeEnv, optionalEnv } from "@aegis/config";

export interface ApiServerConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigin: string;
  readonly nodeEnv: NodeEnv;
  readonly logLevel: string;
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
  };
}
