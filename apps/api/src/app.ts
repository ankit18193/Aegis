import { createLogger, type Logger } from "@aegis/logger";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";

import { loadApiConfig } from "./config/index.js";
import { createDatabaseContext, type DatabaseContext } from "./db/client.js";
import { registerCorrelationHooks } from "./middleware/correlation.js";
import { registerErrorHandlers } from "./middleware/errorHandler.js";
import { InMemoryRunRepository } from "./repositories/inMemoryRunRepository.js";
import { PostgresRunRepository } from "./repositories/postgresRunRepository.js";
import type { IRunRepository } from "./repositories/runRepository.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRunRoutes } from "./routes/runs.js";
import { AgentRunService } from "./services/agentRunService.js";
import type { RunApplicationService } from "./services/runService.js";
import { ToolActionExecutor } from "./tools/adapter.js";
import { registerBuiltinTools } from "./tools/builtins/index.js";
import { ToolExecutor } from "./tools/executor.js";
import { type IToolRegistry, ToolRegistry } from "./tools/registry.js";

export interface BuildAppOptions {
  logger?: Logger | undefined;
  corsOrigin?: string | string[] | undefined;
  runRepository?: IRunRepository | undefined;
  runService?: AgentRunService | RunApplicationService | undefined;
  databaseContext?: DatabaseContext | undefined;
  toolRegistry?: IToolRegistry | undefined;
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
  let repository = options.runRepository;
  if (!repository) {
    if (options.databaseContext) {
      repository = new PostgresRunRepository(options.databaseContext);
    } else if (config.nodeEnv !== "test" && config.database.url) {
      const dbContext = createDatabaseContext(config.database);
      repository = new PostgresRunRepository(dbContext);
    } else {
      repository = new InMemoryRunRepository(true);
    }
  }

  let runService = options.runService;
  if (!runService) {
    let actionExecutor: ToolActionExecutor | undefined;
    if (options.toolRegistry) {
      const toolExecutor = new ToolExecutor(options.toolRegistry);
      actionExecutor = new ToolActionExecutor(toolExecutor);
    } else {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const toolExecutor = new ToolExecutor(registry);
      actionExecutor = new ToolActionExecutor(toolExecutor);
    }

    runService = new AgentRunService(repository, logger, {
      executor: actionExecutor,
      policy: { maxIterations: config.agent.maxIterations },
    });
  }

  // Register health & readiness routes
  registerHealthRoutes(app);

  // Register run operations & event routes
  registerRunRoutes(app, runService);

  return app;
}
