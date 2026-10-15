/**
 * Aegis API — Application Entry Point
 *
 * Phase 13C: Execution Event → SSE Delivery.
 * Initializes Fastify HTTP server, registers canonical contract routes,
 * structured logging, CORS, PostgreSQL persistence layer, Kafka consumer,
 * and SSE event gateway with per-instance broadcast consumer group.
 */

import { randomUUID } from "node:crypto";

import { createLogger } from "@aegis/logger";
import { sql } from "drizzle-orm";

import { buildApp } from "./app.js";
import { loadApiConfig } from "./config/index.js";
import { createDatabaseContext, type DatabaseContext } from "./db/client.js";
import { TaskLeaseMonitor } from "./dispatch/leaseMonitor.js";
import { OrphanRecoveryCoordinator } from "./dispatch/recoveryCoordinator.js";
import { DeterministicWorkerSelector } from "./dispatch/workerSelector.js";
import { OutboxPublisher } from "./events/outboxPublisher.js";
import { KafkaClientManager } from "./infrastructure/kafka/client.js";
import { KafkaEventConsumer } from "./infrastructure/kafka/consumer.js";
import {
  initializeKafkaConsumer,
  initializeKafkaPublisher,
  registerKafkaConsumerLifecycleHooks,
  registerKafkaLifecycleHooks,
} from "./infrastructure/kafka/lifecycle.js";
import { KafkaEventPublisher } from "./infrastructure/kafka/publisher.js";
import { McpProcessRegistry } from "./mcp/lifecycle.js";
import { InMemoryWorkerRegistry } from "./presence/workerRegistry.js";
import { InMemoryRunRepository } from "./repositories/inMemoryRunRepository.js";
import { PostgresOutboxRepository } from "./repositories/postgresOutboxRepository.js";
import { PostgresRunRepository } from "./repositories/postgresRunRepository.js";
import type { IRunRepository } from "./repositories/runRepository.js";
import { SseEventGateway, SseTransportManager } from "./sse/index.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger(config.logLevel as Parameters<typeof createLogger>[0], {
    service: "api",
  });

  logger.info("Aegis API initializing", {
    version: "0.1.0",
    phase: "Phase 12D — Orphan Recovery & Automatic Reassignment",
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

  let outboxPublisher: OutboxPublisher | undefined;
  let eventPublisher: KafkaEventPublisher | undefined;
  let eventConsumer: KafkaEventConsumer | undefined;
  let sseGateway: SseEventGateway | undefined;

  // Shared SSE transport manager — passed to both the Fastify route handler and the gateway
  const sseTransportManager = new SseTransportManager({ logger });

  if (databaseContext) {
    const outboxRepo = new PostgresOutboxRepository(databaseContext.db, logger);

    // Per-instance unique consumer group for SSE broadcast fan-out.
    // Kafka consumer groups distribute messages between members; to broadcast every event
    // to every API replica's SSE connections, each replica must use a unique group ID.
    // Pattern: <base-group>-sse-<instanceId> ensures per-replica message delivery.
    const instanceId = randomUUID().slice(0, 8);
    const sseConsumerGroupId = `${config.kafka.groupId}-sse-${instanceId}`;

    const kafkaManager = new KafkaClientManager({ config: config.kafka, logger });
    eventPublisher = new KafkaEventPublisher({
      producer: kafkaManager.getProducer(),
      topic: config.kafka.eventsTopic,
      logger,
    });
    await initializeKafkaPublisher(eventPublisher, logger);

    outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher,
      logger,
    });
    outboxPublisher.start();

    // Phase 13C: Kafka consumer → SseEventGateway pipeline
    // The consumer uses a per-instance group so every replica sees every event.
    eventConsumer = new KafkaEventConsumer({
      consumer: kafkaManager.getConsumer(sseConsumerGroupId),
      topic: config.kafka.eventsTopic,
      logger,
    });

    sseGateway = new SseEventGateway({
      subscriber: eventConsumer,
      transportManager: sseTransportManager,
      logger,
    });
    sseGateway.register();

    await initializeKafkaConsumer(eventConsumer, logger);

    logger.info("SSE event gateway initialized", {
      consumerGroup: sseConsumerGroupId,
      topic: config.kafka.eventsTopic,
    });
  }

  const workerRegistry = new InMemoryWorkerRegistry({ logger });
  const workerSelector = new DeterministicWorkerSelector({ logger });

  const recoveryCoordinator = new OrphanRecoveryCoordinator({
    repository,
    workerRegistry,
    workerSelector,
    logger,
  });
  void recoveryCoordinator.start();

  const leaseMonitor = new TaskLeaseMonitor({
    repository,
    logger,
    onLeaseExpired: (task) => {
      void recoveryCoordinator.recoverOrphan(task.id, task);
    },
  });
  leaseMonitor.start();

  const app = await buildApp({
    logger,
    runRepository: repository,
    databaseContext,
    outboxPublisher,
    recoveryCoordinator,
    sseTransportManager,
  });

  if (eventPublisher) {
    registerKafkaLifecycleHooks(app, { publisher: eventPublisher, logger });
  }

  if (eventConsumer) {
    registerKafkaConsumerLifecycleHooks(app, { consumer: eventConsumer, logger });
  }

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
        leaseMonitor.stop();
        await recoveryCoordinator.stop();
        if (sseGateway) {
          sseGateway.unregister();
        }
        if (outboxPublisher) {
          await outboxPublisher.stop();
        }
        await app.close();
        await sseTransportManager.closeAll("server_shutdown");
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

