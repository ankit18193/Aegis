/**
 * Aegis Worker — Application Entry Point
 *
 * Phase 11A: Worker Foundation
 *
 * Starts the Aegis Worker process runtime with canonical identity,
 * lifecycle state management, and graceful shutdown handlers.
 */

import { runWorkerProcess } from "./worker/runner.js";

async function main(): Promise<void> {
  await runWorkerProcess({
    onExit: (code) => {
      process.exit(code);
    },
  });
}

main().catch((error: unknown) => {
  console.error("Fatal unhandled error during worker startup:", error);
  process.exit(1);
});

