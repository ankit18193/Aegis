/**
 * Aegis API — Application Entry Point
 *
 * Phase 5: Persistent State.
 * Initializes Fastify HTTP server, registers canonical contract routes,
 * structured logging, CORS, PostgreSQL persistence layer, and lifecycle shutdown.
 */

import { createLogger } from "@aegis/logger";
import { sql } from "drizzle-orm";

import { buildApp } from "./app.js";
import { loadApiConfig } from "./config/index.js";
import { createDatabaseContext, type DatabaseContext } from "./db/client.js";
import { McpProcessRegistry } from "./mcp/lifecycle.js";
import { InMemoryRunRepository } from "./repositories/inMemoryRunRepository.js";
import { PostgresRunRepository } from "./repositories/postgresRunRepository.js";
import type { IRunRepository } from "./repositories/runRepository.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger(config.logLevel as Parameters<typeof createLogger>[0], {
    service: "api",
  });

  logger.info("Aegis API initializing", {
    version: "0.1.0",
    phase: "Phase 5 — Persistent State",
    port: config.port,
    host: config.host,
    nodeEnv: config.nodeEnv,
    corsOrigin: config.corsOrigin,
    databaseConfigured: Boolean(config.database.url),
  });

  let databaseContext: DatabaseContext | undefined;
  let repository: IRunRepository;

  if (config.database.url) {
    try {
      const candidateCtx = createDatabaseContext(config.database);
      await Promise.race([
        candidateCtx.db.execute(sql`SELECT 1`),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("Database connection ping timed out after 2000ms"));
          }, 2000);
        }),
      ]);
      databaseContext = candidateCtx;
      repository = new PostgresRunRepository(databaseContext);
      logger.info("PostgreSQL persistence layer initialized and connected", {
        poolMin: config.database.poolMin,
        poolMax: config.database.poolMax,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("PostgreSQL unavailable; falling back to in-memory repository", {
        error: msg,
      });
      repository = new InMemoryRunRepository(true);
    }
  } else {
    repository = new InMemoryRunRepository(true);
    logger.warn("No DATABASE_URL configured; falling back to in-memory repository");
  }

  const app = await buildApp({
    logger,
    runRepository: repository,
    databaseContext,
  });

  McpProcessRegistry.getInstance().attachSignalHandlers();

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
    McpProcessRegistry.getInstance().detachSignalHandlers();
    if (databaseContext) {
      await databaseContext.close();
    }
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      void (async () => {
        McpProcessRegistry.getInstance().detachSignalHandlers();
        await app.close();
        if (databaseContext) {
          await databaseContext.close();
        }
        logger.info("Aegis API closed successfully");
        process.exit(0);
      })();
    });
  }
}

void main();

