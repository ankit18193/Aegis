/**
 * Kafka Lifecycle Management.
 * Attaches graceful startup and shutdown hooks to the Fastify instance
 * for the Kafka event publisher, ensuring non-blocking failure containment.
 */

import type { Logger } from "@aegis/logger";
import type { FastifyInstance } from "fastify";

import type { KafkaEventPublisher } from "./publisher.js";

export interface KafkaLifecycleOptions {
  readonly publisher: KafkaEventPublisher;
  readonly logger?: Logger | undefined;
  readonly shutdownTimeoutMs?: number | undefined;
}

/**
 * Connects the Kafka publisher with non-blocking failure containment.
 * If connection fails, logs a warning but DOES NOT throw, allowing
 * the API server to start cleanly even if Kafka is unreachable.
 */
export async function initializeKafkaPublisher(
  publisher: KafkaEventPublisher,
  logger?: Logger,
): Promise<boolean> {
  try {
    const result = await publisher.connect();
    if (!result.ok) {
      logger?.warn(
        "Kafka event backbone is unavailable at startup. Operating with degraded event streaming.",
        {
          code: result.error.code,
          error: result.error.message,
        },
      );
      return false;
    }
    logger?.info("Kafka event backbone connected and ready for publishing", {
      topic: publisher.targetTopic,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn(
      "Unexpected error connecting to Kafka event backbone at startup. Operating with degraded event streaming.",
      {
        error: message,
      },
    );
    return false;
  }
}

/**
 * Registers Fastify lifecycle hooks for KafkaEventPublisher.
 * Ensures clean producer disconnection on server close with timeout protection.
 */
export function registerKafkaLifecycleHooks(
  app: FastifyInstance,
  options: KafkaLifecycleOptions,
): void {
  const { publisher, logger, shutdownTimeoutMs = 5000 } = options;

  app.addHook("onClose", async () => {
    if (!publisher.connected) {
      return;
    }

    logger?.info("Disconnecting Kafka event publisher on server shutdown...");

    // Timeout protection for graceful shutdown
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ ok: false; error: { code: string; message: string } }>(
      (resolve) => {
        timer = setTimeout(() => {
          resolve({
            ok: false,
            error: {
              code: "KAFKA_DISCONNECT_TIMEOUT",
              message: `Kafka disconnect timed out after ${String(shutdownTimeoutMs)}ms`,
            },
          });
        }, shutdownTimeoutMs);
      },
    );

    try {
      const res = await Promise.race([publisher.disconnect(), timeoutPromise]);
      if (!res.ok) {
        logger?.warn("Failed or timed out while disconnecting Kafka publisher", {
          error: res.error.message,
        });
      } else {
        logger?.info("Kafka event publisher disconnected cleanly");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("Unexpected exception during Kafka publisher disconnect", { error: message });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}
