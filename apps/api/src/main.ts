/**
 * Aegis API — Application Entry Point
 *
 * Phase 3: API Foundation.
 * Initializes Fastify HTTP server, registers canonical contract routes,
 * structured logging, CORS, and starts listening on the configured port.
 */

import { createLogger } from "@aegis/logger";

import { buildApp } from "./app.js";
import { loadApiConfig } from "./config/index.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger(config.logLevel as Parameters<typeof createLogger>[0], {
    service: "api",
  });

  logger.info("Aegis API initializing", {
    version: "0.1.0",
    phase: "Phase 3 — API Foundation",
    port: config.port,
    host: config.host,
    nodeEnv: config.nodeEnv,
    corsOrigin: config.corsOrigin,
  });

  const app = await buildApp({ logger });

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    logger.info(`Aegis API listening at ${address}`, {
      port: config.port,
      host: config.host,
    });
  } catch (err: unknown) {
    logger.error("Failed to start Aegis API server", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      void app.close().then(() => {
        logger.info("Aegis API closed successfully");
        process.exit(0);
      });
    });
  }
}

void main();
