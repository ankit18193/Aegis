import { createLogger, type Logger } from "@aegis/logger";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";

import { loadApiConfig } from "./config/index.js";
import { registerCorrelationHooks } from "./middleware/correlation.js";

export interface BuildAppOptions {
  logger?: Logger;
  corsOrigin?: string | string[];
}

/**
 * Fastify application factory for Aegis API service.
 * Configures CORS, request correlation, structured access logging, and routing.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadApiConfig();
  const logger = options.logger ?? createLogger(config.logLevel as Parameters<typeof createLogger>[0], {
    service: "api",
  });

  const app = fastify({
    logger: false, // We use @aegis/logger via hooks
  });

  // Register CORS
  await app.register(cors, {
    origin: options.corsOrigin ?? config.corsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
    exposedHeaders: ["x-request-id"],
  });

  // Register correlation & access logging
  registerCorrelationHooks(app, logger);

  return app;
}
