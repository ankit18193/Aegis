/**
 * Aegis Worker — Application Entry Point
 *
 * Phase 0: Foundation placeholder.
 *
 * This is the entry point for the Aegis distributed execution worker.
 * In future phases, this will:
 * - Connect to the event bus (Kafka)
 * - Subscribe to task assignment topics
 * - Execute agent tasks
 * - Report results back to the orchestrator
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
    service: "worker",
  });

  logger.info("Aegis Worker starting", {
    version: "0.1.0",
    phase: "Phase 0 — Foundation",
    nodeEnv: config.nodeEnv,
  });

  // Demonstrate the health system works end-to-end
  const health = aggregatePlatformHealth([
    createComponentHealth("worker", HealthStatus.Healthy, "Initializing"),
  ]);

  logger.info("Worker health check", {
    status: health.status,
    components: health.components.length,
  });

  logger.info("Aegis Worker is ready", {
    note: "No task queue consumer in Phase 0 — foundation only",
  });
}

try {
  main();
} catch (error: unknown) {
  console.error("Fatal error during startup:", error);
  process.exit(1);
}
