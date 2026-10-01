import { loadBaseConfig, loadWorkerConfig } from "@aegis/config";
import type { Logger } from "@aegis/logger";
import { createLogger } from "@aegis/logger";

import { createWorkerFromConfig } from "./bootstrap.js";
import type { WorkerRuntime } from "./runtime.js";

export interface WorkerProcessOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger?: Logger | undefined;
  readonly registerSignalHandlers?: boolean | undefined;
  readonly onExit?: ((code: number) => void) | undefined;
}

export interface WorkerProcessHandle {
  readonly runtime: WorkerRuntime;
  readonly shutdown: (signal?: string) => Promise<number>;
}

/**
 * Runs the worker process lifecycle: loads configuration, initializes WorkerRuntime,
 * starts the worker, and wires graceful shutdown with timeout guardrails.
 */
export async function runWorkerProcess(
  options: WorkerProcessOptions = {},
): Promise<WorkerProcessHandle> {
  const baseConfig = loadBaseConfig();
  const workerConfig = loadWorkerConfig(options.env);
  const logger =
    options.logger ??
    createLogger(baseConfig.logLevel as Parameters<typeof createLogger>[0], {
      service: "worker",
    });

  const runtime = createWorkerFromConfig({
    config: workerConfig,
    logger,
  });

  const identity = runtime.getIdentity();
  logger.info("Worker process initializing", {
    workerId: identity.id,
    workerName: identity.name,
    maxConcurrency: identity.capabilities.maxConcurrency,
    taskTypes: identity.capabilities.taskTypes,
    shutdownTimeoutMs: workerConfig.shutdownTimeoutMs,
  });

  const startResult = await runtime.start();
  if (!startResult.ok) {
    logger.error("Failed to start worker runtime", {
      code: startResult.error.code,
      message: startResult.error.message,
    });
    options.onExit?.(1);
    return {
      runtime,
      shutdown: () => Promise.resolve(1),
    };
  }

  logger.info("Worker process is ready", {
    workerId: identity.id,
    state: runtime.getState(),
  });

  let isShuttingDown = false;

  const performShutdown = async (signal = "MANUAL"): Promise<number> => {
    if (isShuttingDown) {
      return 0;
    }
    isShuttingDown = true;

    logger.info(`Received ${signal}, initiating graceful worker shutdown`, {
      workerId: identity.id,
      timeoutMs: workerConfig.shutdownTimeoutMs,
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<number>((resolve) => {
      timeoutTimer = setTimeout(() => {
        logger.error("Worker shutdown timed out, aborting gracefully", {
          workerId: identity.id,
          timeoutMs: workerConfig.shutdownTimeoutMs,
        });
        options.onExit?.(1);
        resolve(1);
      }, workerConfig.shutdownTimeoutMs);

      if (typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }
    });

    const stopPromise = (async (): Promise<number> => {
      try {
        const stopResult = await runtime.stop();
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }

        if (!stopResult.ok) {
          logger.error("Worker stop returned error", {
            code: stopResult.error.code,
            message: stopResult.error.message,
          });
          options.onExit?.(1);
          return 1;
        }

        logger.info("Worker process stopped cleanly", {
          workerId: identity.id,
          state: runtime.getState(),
        });
        options.onExit?.(0);
        return 0;
      } catch (err: unknown) {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        logger.error("Unexpected error during worker shutdown", {
          workerId: identity.id,
          error: err instanceof Error ? err.message : String(err),
        });
        options.onExit?.(1);
        return 1;
      }
    })();

    return Promise.race([stopPromise, timeoutPromise]);
  };

  if (options.registerSignalHandlers !== false) {
    const handleSigint = (): void => {
      void performShutdown("SIGINT");
    };
    const handleSigterm = (): void => {
      void performShutdown("SIGTERM");
    };

    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
  }

  return {
    runtime,
    shutdown: performShutdown,
  };
}
