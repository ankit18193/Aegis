import type { Logger } from "@aegis/logger";
import fastify, { type FastifyInstance } from "fastify";
import type { Consumer, Producer } from "kafkajs";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KafkaEventConsumer } from "../consumer.js";
import {
  initializeKafkaConsumer,
  initializeKafkaPublisher,
  registerKafkaConsumerLifecycleHooks,
  registerKafkaLifecycleHooks,
} from "../lifecycle.js";
import { KafkaEventPublisher } from "../publisher.js";

interface MockLoggerBundle {
  readonly logger: Logger;
  readonly infoSpy: Mock<(msg: string, ctx?: Record<string, unknown>) => void>;
  readonly warnSpy: Mock<(msg: string, ctx?: Record<string, unknown>) => void>;
  readonly errorSpy: Mock<(msg: string, ctx?: Record<string, unknown>) => void>;
  readonly debugSpy: Mock<(msg: string, ctx?: Record<string, unknown>) => void>;
}

function createMockLoggerBundle(): MockLoggerBundle {
  const infoSpy = vi.fn<(msg: string, ctx?: Record<string, unknown>) => void>();
  const warnSpy = vi.fn<(msg: string, ctx?: Record<string, unknown>) => void>();
  const errorSpy = vi.fn<(msg: string, ctx?: Record<string, unknown>) => void>();
  const debugSpy = vi.fn<(msg: string, ctx?: Record<string, unknown>) => void>();

  const logger = {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy,
  } as unknown as Logger;

  return {
    logger,
    infoSpy,
    warnSpy,
    errorSpy,
    debugSpy,
  };
}

interface MockProducerBundle {
  readonly producer: Producer;
  readonly connectSpy: Mock<() => Promise<void>>;
  readonly disconnectSpy: Mock<() => Promise<void>>;
}

function createMockProducerBundle(): MockProducerBundle {
  const connectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const disconnectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const producer = {
    connect: connectSpy,
    disconnect: disconnectSpy,
    send: vi.fn(),
    sendBatch: vi.fn(),
    isIdempotent: vi.fn().mockReturnValue(true),
    events: {},
    on: vi.fn(),
    logger: vi.fn(),
    transaction: vi.fn(),
  } as unknown as Producer;

  return {
    producer,
    connectSpy,
    disconnectSpy,
  };
}

interface MockConsumerBundle {
  readonly consumer: Consumer;
  readonly connectSpy: Mock<() => Promise<void>>;
  readonly disconnectSpy: Mock<() => Promise<void>>;
  readonly subscribeSpy: Mock<() => Promise<void>>;
  readonly runSpy: Mock<() => Promise<void>>;
  readonly stopSpy: Mock<() => Promise<void>>;
}

function createMockConsumerBundle(): MockConsumerBundle {
  const connectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const disconnectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const subscribeSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const runSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const stopSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const consumer = {
    connect: connectSpy,
    disconnect: disconnectSpy,
    subscribe: subscribeSpy,
    run: runSpy,
    stop: stopSpy,
    commitOffsets: vi.fn().mockResolvedValue(undefined),
    events: {},
    on: vi.fn(),
    logger: vi.fn(),
  } as unknown as Consumer;

  return {
    consumer,
    connectSpy,
    disconnectSpy,
    subscribeSpy,
    runSpy,
    stopSpy,
  };
}

describe("Kafka Lifecycle Subsystem", () => {
  let app: FastifyInstance;
  let loggerBundle: MockLoggerBundle;
  let bundle: MockProducerBundle;
  let publisher: KafkaEventPublisher;

  beforeEach(() => {
    app = fastify({ logger: false });
    loggerBundle = createMockLoggerBundle();
    bundle = createMockProducerBundle();
    publisher = new KafkaEventPublisher({
      producer: bundle.producer,
      topic: "aegis.events",
      logger: loggerBundle.logger,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("initializeKafkaPublisher (Startup Non-Blocking Failure Containment)", () => {
    it("returns true when connection succeeds", async () => {
      const success = await initializeKafkaPublisher(publisher, loggerBundle.logger);

      expect(success).toBe(true);
      expect(publisher.connected).toBe(true);
      expect(bundle.connectSpy).toHaveBeenCalledTimes(1);
      expect(loggerBundle.infoSpy).toHaveBeenCalled();
    });

    it("returns false and logs warning when connection fails without throwing", async () => {
      bundle.connectSpy.mockRejectedValueOnce(
        new Error("Broker coordinator not available: ECONNREFUSED"),
      );

      const success = await initializeKafkaPublisher(publisher, loggerBundle.logger);

      expect(success).toBe(false);
      expect(publisher.connected).toBe(false);
      expect(loggerBundle.warnSpy).toHaveBeenCalledTimes(1);
      const callArgs = loggerBundle.warnSpy.mock.calls[0];
      expect(callArgs?.[0]).toBe(
        "Kafka event backbone is unavailable at startup. Operating with degraded event streaming.",
      );
      expect(callArgs?.[1]?.["code"]).toBe("BROKER_UNAVAILABLE");
    });

    it("handles unexpected thrown non-Error values gracefully", async () => {
      bundle.connectSpy.mockRejectedValueOnce("critical string failure");

      const success = await initializeKafkaPublisher(publisher, loggerBundle.logger);

      expect(success).toBe(false);
      expect(publisher.connected).toBe(false);
      expect(loggerBundle.warnSpy).toHaveBeenCalled();
    });
  });

  describe("registerKafkaLifecycleHooks (Shutdown Handling)", () => {
    it("skips disconnect on shutdown if publisher was never connected", async () => {
      registerKafkaLifecycleHooks(app, {
        publisher,
        logger: loggerBundle.logger,
      });

      await app.ready();
      await app.close();

      expect(bundle.disconnectSpy).not.toHaveBeenCalled();
    });

    it("disconnects publisher cleanly on Fastify close", async () => {
      await publisher.connect();
      expect(publisher.connected).toBe(true);

      registerKafkaLifecycleHooks(app, {
        publisher,
        logger: loggerBundle.logger,
      });

      await app.ready();
      await app.close();

      expect(bundle.disconnectSpy).toHaveBeenCalledTimes(1);
      expect(publisher.connected).toBe(false);
    });

    it("handles disconnect error during shutdown without throwing or blocking server close", async () => {
      await publisher.connect();
      bundle.disconnectSpy.mockRejectedValueOnce(new Error("Socket closed unexpectedly"));

      registerKafkaLifecycleHooks(app, {
        publisher,
        logger: loggerBundle.logger,
      });

      await app.ready();
      // Server close should not throw
      await expect(app.close()).resolves.toBeUndefined();
      expect(loggerBundle.warnSpy).toHaveBeenCalled();
    });

    it("times out if disconnect hangs", async () => {
      await publisher.connect();
      // Simulate hanging disconnect that never resolves
      bundle.disconnectSpy.mockImplementationOnce(() => new Promise<void>((_resolve) => {
        // intentional hang for timeout test
      }));

      registerKafkaLifecycleHooks(app, {
        publisher,
        logger: loggerBundle.logger,
        shutdownTimeoutMs: 50, // Short timeout for unit test
      });

      await app.ready();
      await expect(app.close()).resolves.toBeUndefined();
      expect(loggerBundle.warnSpy).toHaveBeenCalledTimes(1);
      const callArgs = loggerBundle.warnSpy.mock.calls[0];
      expect(callArgs?.[0]).toBe("Failed or timed out while disconnecting Kafka publisher");
      expect(typeof callArgs?.[1]?.["error"]).toBe("string");
    });
  });

  describe("initializeKafkaConsumer (Startup Non-Blocking Failure Containment)", () => {
    let consumerBundle: MockConsumerBundle;
    let consumer: KafkaEventConsumer;

    beforeEach(() => {
      consumerBundle = createMockConsumerBundle();
      consumer = new KafkaEventConsumer({
        consumer: consumerBundle.consumer,
        topic: "aegis.events",
        logger: loggerBundle.logger,
      });
    });

    it("returns true when consumer start succeeds", async () => {
      const success = await initializeKafkaConsumer(consumer, loggerBundle.logger);

      expect(success).toBe(true);
      expect(consumer.isRunning).toBe(true);
      expect(consumerBundle.connectSpy).toHaveBeenCalledTimes(1);
      expect(consumerBundle.subscribeSpy).toHaveBeenCalledTimes(1);
      expect(consumerBundle.runSpy).toHaveBeenCalledTimes(1);
      expect(loggerBundle.infoSpy).toHaveBeenCalled();
    });

    it("returns false and logs warning when consumer start fails without throwing", async () => {
      consumerBundle.connectSpy.mockRejectedValueOnce(new Error("Broker connection refused"));

      const success = await initializeKafkaConsumer(consumer, loggerBundle.logger);

      expect(success).toBe(false);
      expect(consumer.isRunning).toBe(false);
      expect(loggerBundle.warnSpy).toHaveBeenCalled();
    });

    it("handles unexpected thrown non-Error values gracefully", async () => {
      consumerBundle.connectSpy.mockRejectedValueOnce("fatal string failure");

      const success = await initializeKafkaConsumer(consumer, loggerBundle.logger);

      expect(success).toBe(false);
      expect(consumer.isRunning).toBe(false);
      expect(loggerBundle.warnSpy).toHaveBeenCalled();
    });
  });

  describe("registerKafkaConsumerLifecycleHooks (Shutdown Handling)", () => {
    let consumerBundle: MockConsumerBundle;
    let consumer: KafkaEventConsumer;

    beforeEach(() => {
      consumerBundle = createMockConsumerBundle();
      consumer = new KafkaEventConsumer({
        consumer: consumerBundle.consumer,
        topic: "aegis.events",
        logger: loggerBundle.logger,
      });
    });

    it("skips stop/disconnect on shutdown if consumer was never running", async () => {
      registerKafkaConsumerLifecycleHooks(app, {
        consumer,
        logger: loggerBundle.logger,
      });

      await app.ready();
      await app.close();

      expect(consumerBundle.stopSpy).not.toHaveBeenCalled();
      expect(consumerBundle.disconnectSpy).not.toHaveBeenCalled();
    });

    it("stops and disconnects consumer cleanly on Fastify close", async () => {
      await consumer.start();

      registerKafkaConsumerLifecycleHooks(app, {
        consumer,
        logger: loggerBundle.logger,
      });

      await app.ready();
      await app.close();

      expect(consumerBundle.stopSpy).toHaveBeenCalledTimes(1);
      expect(consumerBundle.disconnectSpy).toHaveBeenCalledTimes(1);
      expect(consumer.isRunning).toBe(false);
    });

    it("handles stop/disconnect error during shutdown without throwing or blocking server close", async () => {
      await consumer.start();
      consumerBundle.stopSpy.mockRejectedValueOnce(new Error("Failed to stop consumer group"));

      registerKafkaConsumerLifecycleHooks(app, {
        consumer,
        logger: loggerBundle.logger,
      });

      await app.ready();
      await expect(app.close()).resolves.toBeUndefined();
      expect(loggerBundle.warnSpy).toHaveBeenCalled();
    });

    it("times out if consumer stop hangs", async () => {
      await consumer.start();
      consumerBundle.stopSpy.mockImplementationOnce(() => new Promise<void>((_resolve) => {
        // intentional hang for timeout test
      }));

      registerKafkaConsumerLifecycleHooks(app, {
        consumer,
        logger: loggerBundle.logger,
        shutdownTimeoutMs: 50,
      });

      await app.ready();
      await expect(app.close()).resolves.toBeUndefined();
      expect(loggerBundle.warnSpy).toHaveBeenCalledTimes(1);
      const callArgs = loggerBundle.warnSpy.mock.calls[0];
      expect(callArgs?.[0]).toBe("Failed or timed out while stopping Kafka consumer");
      expect(typeof callArgs?.[1]?.["error"]).toBe("string");
    });
  });
});
