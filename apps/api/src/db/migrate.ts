/**
 * Standalone migration CLI script.
 * Can be executed via `pnpm db:migrate` without running the HTTP API server.
 */

import { createLogger } from "@aegis/logger";

import { createDatabaseContext } from "./client.js";
import { runMigrations } from "./migrator.js";

async function main(): Promise<void> {
  const logger = createLogger("info", { service: "migrator" });
  logger.info("Executing Aegis schema migrations...");

  const ctx = createDatabaseContext();
  try {
    await runMigrations(ctx.db);
    logger.info("Database migrations applied successfully.");
  } catch (err: unknown) {
    logger.error("Failed to execute database migrations", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await ctx.close();
  }
}

void main();
