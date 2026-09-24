import type { Logger } from "@aegis/logger";
import fastify, { type FastifyInstance } from "fastify";
import type { Producer } from "kafkajs";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initializeKafkaPublisher,
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
});
