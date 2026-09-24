import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getNodeEnv,
  isProduction,
  isTest,
  loadAgentConfig,
  loadBaseConfig,
  loadDatabaseConfig,
  loadKafkaConfig,
  optionalEnv,
  requireEnv,
} from "./index.js";

describe("@aegis/config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Environment Helpers", () => {
    it("returns correct nodeEnv and predicates", () => {
      process.env["NODE_ENV"] = "production";
      expect(getNodeEnv()).toBe("production");
      expect(isProduction()).toBe(true);
      expect(isTest()).toBe(false);

      process.env["NODE_ENV"] = "test";
      expect(getNodeEnv()).toBe("test");
      expect(isProduction()).toBe(false);
      expect(isTest()).toBe(true);

      process.env["NODE_ENV"] = "other";
      expect(getNodeEnv()).toBe("development");
    });

    it("requires environment variable or throws", () => {
      process.env["TEST_KEY"] = "hello";
      expect(requireEnv("TEST_KEY")).toBe("hello");

      delete process.env["TEST_KEY"];
      expect(() => requireEnv("TEST_KEY")).toThrow(/Required environment variable/);
    });

    it("returns optional environment variable with fallback", () => {
      expect(optionalEnv("NON_EXISTENT", "default_val")).toBe("default_val");
      process.env["EXISTING"] = "val";
      expect(optionalEnv("EXISTING", "default_val")).toBe("val");
    });
  });

  describe("loadBaseConfig", () => {
    it("loads base config with defaults", () => {
      delete process.env["LOG_LEVEL"];
      const config = loadBaseConfig();
      expect(config.logLevel).toBe("info");
      expect(config.nodeEnv).toBeDefined();
    });
  });

  describe("loadDatabaseConfig", () => {
    it("loads database config with default pool values when url is unset", () => {
      delete process.env["DATABASE_URL"];
      delete process.env["DATABASE_POOL_MIN"];
      delete process.env["DATABASE_POOL_MAX"];

      const dbConfig = loadDatabaseConfig();
      expect(dbConfig.url).toBeUndefined();
      expect(dbConfig.poolMin).toBe(2);
      expect(dbConfig.poolMax).toBe(10);
    });

    it("loads custom database url and pool settings", () => {
      process.env["DATABASE_URL"] = "postgresql://user:pass@localhost:5432/aegis";
      process.env["DATABASE_POOL_MIN"] = "4";
      process.env["DATABASE_POOL_MAX"] = "20";

      const dbConfig = loadDatabaseConfig();
      expect(dbConfig.url).toBe("postgresql://user:pass@localhost:5432/aegis");
      expect(dbConfig.poolMin).toBe(4);
      expect(dbConfig.poolMax).toBe(20);
    });

    it("handles invalid pool numbers gracefully with fallbacks", () => {
      process.env["DATABASE_POOL_MIN"] = "invalid";
      process.env["DATABASE_POOL_MAX"] = "-5";

      const dbConfig = loadDatabaseConfig();
      expect(dbConfig.poolMin).toBe(2);
      expect(dbConfig.poolMax).toBe(10);
    });
  });

  describe("loadAgentConfig", () => {
    it("loads agent config with default maxIterations when unset", () => {
      delete process.env["AGENT_MAX_ITERATIONS"];

      const agentConfig = loadAgentConfig();
      expect(agentConfig.maxIterations).toBe(10);
    });

    it("loads custom maxIterations", () => {
      process.env["AGENT_MAX_ITERATIONS"] = "25";

      const agentConfig = loadAgentConfig();
      expect(agentConfig.maxIterations).toBe(25);
    });

    it("falls back to default 10 when maxIterations is invalid or non-positive", () => {
      process.env["AGENT_MAX_ITERATIONS"] = "invalid";
      expect(loadAgentConfig().maxIterations).toBe(10);

      process.env["AGENT_MAX_ITERATIONS"] = "0";
      expect(loadAgentConfig().maxIterations).toBe(10);

      process.env["AGENT_MAX_ITERATIONS"] = "-3";
      expect(loadAgentConfig().maxIterations).toBe(10);
    });
  });

  describe("loadKafkaConfig", () => {
    it("loads default Kafka configuration when environment variables are unset", () => {
      delete process.env["KAFKA_BROKERS"];
      delete process.env["KAFKA_CLIENT_ID"];
      delete process.env["KAFKA_EVENTS_TOPIC"];
      delete process.env["KAFKA_CONNECTION_TIMEOUT_MS"];
      delete process.env["KAFKA_REQUEST_TIMEOUT_MS"];
      delete process.env["KAFKA_MAX_RETRIES"];
      delete process.env["KAFKA_RETRY_INITIAL_DELAY_MS"];
      delete process.env["KAFKA_RETRY_MAX_DELAY_MS"];

      const config = loadKafkaConfig();
      expect(config.brokers).toEqual(["localhost:9092"]);
      expect(config.clientId).toBe("aegis-api");
      expect(config.eventsTopic).toBe("aegis.events");
      expect(config.connectionTimeoutMs).toBe(5000);
      expect(config.requestTimeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(5);
      expect(config.retryInitialDelayMs).toBe(100);
      expect(config.retryMaxDelayMs).toBe(1000);
    });

    it("parses comma-separated broker list and trims whitespace", () => {
      process.env["KAFKA_BROKERS"] = "broker1:9092, broker2:9092 , broker3:9092 ";
      const config = loadKafkaConfig();
      expect(config.brokers).toEqual(["broker1:9092", "broker2:9092", "broker3:9092"]);
    });

    it("handles whitespace-only broker list by falling back to default", () => {
      process.env["KAFKA_BROKERS"] = "   ,  ";
      const config = loadKafkaConfig();
      expect(config.brokers).toEqual(["localhost:9092"]);
    });

    it("parses custom client ID and topic", () => {
      process.env["KAFKA_CLIENT_ID"] = "custom-engine";
      process.env["KAFKA_EVENTS_TOPIC"] = "engine.events";

      const config = loadKafkaConfig();
      expect(config.clientId).toBe("custom-engine");
      expect(config.eventsTopic).toBe("engine.events");
    });

    it("parses custom numeric configuration", () => {
      process.env["KAFKA_CONNECTION_TIMEOUT_MS"] = "10000";
      process.env["KAFKA_REQUEST_TIMEOUT_MS"] = "45000";
      process.env["KAFKA_MAX_RETRIES"] = "8";
      process.env["KAFKA_RETRY_INITIAL_DELAY_MS"] = "250";
      process.env["KAFKA_RETRY_MAX_DELAY_MS"] = "3000";

      const config = loadKafkaConfig();
      expect(config.connectionTimeoutMs).toBe(10000);
      expect(config.requestTimeoutMs).toBe(45000);
      expect(config.maxRetries).toBe(8);
      expect(config.retryInitialDelayMs).toBe(250);
      expect(config.retryMaxDelayMs).toBe(3000);
    });

    it("falls back to defaults for invalid numeric values", () => {
      process.env["KAFKA_CONNECTION_TIMEOUT_MS"] = "invalid";
      process.env["KAFKA_REQUEST_TIMEOUT_MS"] = "-50";
      process.env["KAFKA_MAX_RETRIES"] = "999"; // exceeds max bound 20
      process.env["KAFKA_RETRY_INITIAL_DELAY_MS"] = "1"; // below min bound 10
      process.env["KAFKA_RETRY_MAX_DELAY_MS"] = "999999"; // exceeds max bound 60000

      const config = loadKafkaConfig();
      expect(config.connectionTimeoutMs).toBe(5000);
      expect(config.requestTimeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(5);
      expect(config.retryInitialDelayMs).toBe(100);
      expect(config.retryMaxDelayMs).toBe(1000);
    });

    it("accepts custom env object parameter", () => {
      const customEnv: NodeJS.ProcessEnv = {
        KAFKA_CLIENT_ID: "isolated-client",
        KAFKA_BROKERS: "remote:9092",
      };
      const config = loadKafkaConfig(customEnv);
      expect(config.clientId).toBe("isolated-client");
      expect(config.brokers).toEqual(["remote:9092"]);
    });
  });
});
