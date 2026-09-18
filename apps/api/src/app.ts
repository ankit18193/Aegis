import { createLogger, type Logger } from "@aegis/logger";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";

import { loadApiConfig } from "./config/index.js";
import { registerCorrelationHooks } from "./middleware/correlation.js";
import { registerErrorHandlers } from "./middleware/errorHandler.js";
import { InMemoryRunRepository } from "./repositories/inMemoryRunRepository.js";
import type { IRunRepository } from "./repositories/runRepository.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRunRoutes } from "./routes/runs.js";
import { RunApplicationService } from "./services/runService.js";

export interface BuildAppOptions {
  logger?: Logger;
  corsOrigin?: string | string[];
  runRepository?: IRunRepository;
  runService?: RunApplicationService;
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

  // Register error and 404 handlers
  registerErrorHandlers(app, logger);

  // Resolve repository & service dependencies
  const repository = options.runRepository ?? new InMemoryRunRepository(true);
  const runService = options.runService ?? new RunApplicationService(repository, logger);

  // Register health & readiness routes
  registerHealthRoutes(app);

  // Register run operations & event routes
  registerRunRoutes(app, runService);

  return app;
}
