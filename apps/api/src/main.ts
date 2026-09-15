/**
 * Aegis API — Application Entry Point
 *
 * Phase 0: Foundation placeholder.
 *
 * This is the entry point for the Aegis API service.
 * In future phases, this will initialize an HTTP server,
 * connect to the database, and register API routes.
 *
 * Current scope:
 * - Reads configuration from the environment
 * - Initializes the logger
 * - Logs startup information
 * - Demonstrates that the workspace dependency graph works
 */

import { loadBaseConfig } from "@aegis/config";
import { HealthStatus, createComponentHealth, aggregatePlatformHealth } from "@aegis/foundation";
import { createLogger } from "@aegis/logger";

function main(): void {
  const config = loadBaseConfig();
  const logger = createLogger(config.logLevel as Parameters<typeof createLogger>[0], {
    service: "api",
  });

  logger.info("Aegis API starting", {
    version: "0.1.0",
    phase: "Phase 0 — Foundation",
    nodeEnv: config.nodeEnv,
  });

  // Demonstrate the health system works end-to-end
  const health = aggregatePlatformHealth([
    createComponentHealth("api", HealthStatus.Healthy, "Initializing"),
  ]);

  logger.info("Platform health check", {
    status: health.status,
    components: health.components.length,
  });

  logger.info("Aegis API is ready", {
    note: "No HTTP server in Phase 0 — foundation only",
  });
}

try {
  main();
} catch (error: unknown) {
  console.error("Fatal error during startup:", error);
  process.exit(1);
}
