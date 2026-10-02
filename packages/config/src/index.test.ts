import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getNodeEnv,
  isProduction,
  isTest,
  loadAgentConfig,
  loadBaseConfig,
  loadDatabaseConfig,
  loadKafkaConfig,
  loadWorkerConfig,
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
      delete process.env["KAFKA_GROUP_ID"];
      delete process.env["KAFKA_SESSION_TIMEOUT_MS"];
      delete process.env["KAFKA_HEARTBEAT_INTERVAL_MS"];
      delete process.env["KAFKA_SHUTDOWN_TIMEOUT_MS"];
      delete process.env["KAFKA_FROM_BEGINNING"];

      const config = loadKafkaConfig();
      expect(config.brokers).toEqual(["localhost:9092"]);
      expect(config.clientId).toBe("aegis-api");
      expect(config.eventsTopic).toBe("aegis.events");
      expect(config.connectionTimeoutMs).toBe(5000);
      expect(config.requestTimeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(5);
      expect(config.retryInitialDelayMs).toBe(100);
      expect(config.retryMaxDelayMs).toBe(1000);
      expect(config.groupId).toBe("aegis-consumer-group");
      expect(config.sessionTimeoutMs).toBe(30000);
      expect(config.heartbeatIntervalMs).toBe(3000);
      expect(config.shutdownTimeoutMs).toBe(10000);
      expect(config.fromBeginning).toBe(false);
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

    it("parses custom consumer configuration (Phase 10B)", () => {
      process.env["KAFKA_GROUP_ID"] = "custom-consumer-group";
      process.env["KAFKA_SESSION_TIMEOUT_MS"] = "45000";
      process.env["KAFKA_HEARTBEAT_INTERVAL_MS"] = "5000";
      process.env["KAFKA_SHUTDOWN_TIMEOUT_MS"] = "15000";
      process.env["KAFKA_FROM_BEGINNING"] = "true";

      const config = loadKafkaConfig();
      expect(config.groupId).toBe("custom-consumer-group");
      expect(config.sessionTimeoutMs).toBe(45000);
      expect(config.heartbeatIntervalMs).toBe(5000);
      expect(config.shutdownTimeoutMs).toBe(15000);
      expect(config.fromBeginning).toBe(true);
    });

    it("falls back to defaults for invalid numeric values", () => {
      process.env["KAFKA_CONNECTION_TIMEOUT_MS"] = "invalid";
      process.env["KAFKA_REQUEST_TIMEOUT_MS"] = "-50";
      process.env["KAFKA_MAX_RETRIES"] = "999"; // exceeds max bound 20
      process.env["KAFKA_RETRY_INITIAL_DELAY_MS"] = "1"; // below min bound 10
      process.env["KAFKA_RETRY_MAX_DELAY_MS"] = "999999"; // exceeds max bound 60000
      process.env["KAFKA_SESSION_TIMEOUT_MS"] = "invalid";
      process.env["KAFKA_HEARTBEAT_INTERVAL_MS"] = "-10";
      process.env["KAFKA_SHUTDOWN_TIMEOUT_MS"] = "999999"; // exceeds max bound 60000

      const config = loadKafkaConfig();
      expect(config.connectionTimeoutMs).toBe(5000);
      expect(config.requestTimeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(5);
      expect(config.retryInitialDelayMs).toBe(100);
      expect(config.retryMaxDelayMs).toBe(1000);
      expect(config.sessionTimeoutMs).toBe(30000);
      expect(config.heartbeatIntervalMs).toBe(3000);
      expect(config.shutdownTimeoutMs).toBe(10000);
    });

    it("accepts custom env object parameter", () => {
      const customEnv: NodeJS.ProcessEnv = {
        KAFKA_CLIENT_ID: "isolated-client",
        KAFKA_BROKERS: "remote:9092",
        KAFKA_GROUP_ID: "isolated-group",
        KAFKA_FROM_BEGINNING: "true",
      };
      const config = loadKafkaConfig(customEnv);
      expect(config.clientId).toBe("isolated-client");
      expect(config.brokers).toEqual(["remote:9092"]);
      expect(config.groupId).toBe("isolated-group");
      expect(config.fromBeginning).toBe(true);
    });
  });

  describe("loadWorkerConfig", () => {
    it("loads default worker configuration when environment variables are unset", () => {
      delete process.env["WORKER_ID"];
      delete process.env["WORKER_NAME"];
      delete process.env["WORKER_MAX_CONCURRENCY"];
      delete process.env["WORKER_TASK_TYPES"];
      delete process.env["WORKER_TOOLS"];
      delete process.env["WORKER_SHUTDOWN_TIMEOUT_MS"];
      delete process.env["AEGIS_TASK_RESULT_TOPIC"];
      delete process.env["AEGIS_WORKER_MAX_CONCURRENT_TASKS"];
      delete process.env["WORKER_HEARTBEAT_INTERVAL_MS"];
      delete process.env["WORKER_HEARTBEAT_TIMEOUT_MS"];
      delete process.env["AEGIS_WORKER_HEARTBEAT_TOPIC"];
      delete process.env["AEGIS_WORKER_PRESENCE_CONSUMER_GROUP"];

      const config = loadWorkerConfig();
      expect(config.workerId).toBeUndefined();
      expect(config.workerName).toBe("aegis-worker-1");
      expect(config.maxConcurrency).toBe(1);
      expect(config.maxConcurrentTasks).toBe(1);
      expect(config.taskTypes).toEqual(["*"]);
      expect(config.tools).toEqual([]);
      expect(config.shutdownTimeoutMs).toBe(10000);
      expect(config.kafkaBrokers).toEqual(["localhost:9092"]);
      expect(config.taskAssignmentTopic).toBe("aegis.tasks.assign");
      expect(config.taskResultTopic).toBe("aegis.tasks.results");
      expect(config.workerConsumerGroupId).toBe("aegis-workers");
      expect(config.workerHeartbeatIntervalMs).toBe(10000);
      expect(config.workerHeartbeatTimeoutMs).toBe(30000);
      expect(config.workerHeartbeatTopic).toBe("aegis.workers.heartbeat");
      expect(config.workerPresenceConsumerGroup).toBe("aegis-worker-presence");
    });

    it("parses custom worker configuration and trims strings", () => {
      process.env["WORKER_ID"] = "worker-custom-99";
      process.env["WORKER_NAME"] = "Custom Analytics Worker";
      process.env["WORKER_MAX_CONCURRENCY"] = "8";
      process.env["WORKER_TASK_TYPES"] = "analysis, transform , summary ";
      process.env["WORKER_TOOLS"] = "calculator, web_search , echo ";
      process.env["WORKER_SHUTDOWN_TIMEOUT_MS"] = "15000";
      process.env["KAFKA_BROKERS"] = "broker1:9092, broker2:9092";
      process.env["AEGIS_TASK_ASSIGNMENT_TOPIC"] = "custom.tasks.assign";
      process.env["AEGIS_WORKER_CONSUMER_GROUP_ID"] = "custom-worker-group";
      process.env["AEGIS_TASK_RESULT_TOPIC"] = "custom.tasks.results";
      process.env["AEGIS_WORKER_MAX_CONCURRENT_TASKS"] = "4";
      process.env["WORKER_HEARTBEAT_INTERVAL_MS"] = "5000";
      process.env["WORKER_HEARTBEAT_TIMEOUT_MS"] = "20000";
      process.env["AEGIS_WORKER_HEARTBEAT_TOPIC"] = "custom.workers.heartbeat";
      process.env["AEGIS_WORKER_PRESENCE_CONSUMER_GROUP"] = "custom-presence-group";

      const config = loadWorkerConfig();
      expect(config.workerId).toBe("worker-custom-99");
      expect(config.workerName).toBe("Custom Analytics Worker");
      expect(config.maxConcurrency).toBe(8);
      expect(config.maxConcurrentTasks).toBe(4);
      expect(config.taskTypes).toEqual(["analysis", "transform", "summary"]);
      expect(config.tools).toEqual(["calculator", "web_search", "echo"]);
      expect(config.shutdownTimeoutMs).toBe(15000);
      expect(config.kafkaBrokers).toEqual(["broker1:9092", "broker2:9092"]);
      expect(config.taskAssignmentTopic).toBe("custom.tasks.assign");
      expect(config.taskResultTopic).toBe("custom.tasks.results");
      expect(config.workerConsumerGroupId).toBe("custom-worker-group");
      expect(config.workerHeartbeatIntervalMs).toBe(5000);
      expect(config.workerHeartbeatTimeoutMs).toBe(20000);
      expect(config.workerHeartbeatTopic).toBe("custom.workers.heartbeat");
      expect(config.workerPresenceConsumerGroup).toBe("custom-presence-group");
    });

    it("falls back to defaults for invalid numeric values or bounds", () => {
      process.env["WORKER_MAX_CONCURRENCY"] = "invalid";
      process.env["WORKER_SHUTDOWN_TIMEOUT_MS"] = "-50";
      process.env["AEGIS_WORKER_MAX_CONCURRENT_TASKS"] = "invalid";
      process.env["WORKER_HEARTBEAT_INTERVAL_MS"] = "invalid";
      process.env["WORKER_HEARTBEAT_TIMEOUT_MS"] = "-100";

      const config = loadWorkerConfig();
      expect(config.maxConcurrency).toBe(1);
      expect(config.maxConcurrentTasks).toBe(1);
      expect(config.shutdownTimeoutMs).toBe(10000);
      expect(config.workerHeartbeatIntervalMs).toBe(10000);
      expect(config.workerHeartbeatTimeoutMs).toBe(30000);

      process.env["WORKER_MAX_CONCURRENCY"] = "-3";
      process.env["WORKER_SHUTDOWN_TIMEOUT_MS"] = "999999"; // exceeds 60000 bound
      process.env["AEGIS_WORKER_MAX_CONCURRENT_TASKS"] = "-2";

      const config2 = loadWorkerConfig();
      expect(config2.maxConcurrency).toBe(1);
      expect(config2.maxConcurrentTasks).toBe(1);
      expect(config2.shutdownTimeoutMs).toBe(10000);
    });

    it("enforces timeout strictly greater than interval invariant", () => {
      process.env["WORKER_HEARTBEAT_INTERVAL_MS"] = "15000";
      process.env["WORKER_HEARTBEAT_TIMEOUT_MS"] = "10000"; // timeout <= interval!

      const config = loadWorkerConfig();
      expect(config.workerHeartbeatIntervalMs).toBe(15000);
      expect(config.workerHeartbeatTimeoutMs).toBe(45000);
    });

    it("accepts custom env parameter directly", () => {
      const customEnv: NodeJS.ProcessEnv = {
        WORKER_ID: "worker-direct-1",
        WORKER_NAME: "Direct Worker",
        WORKER_MAX_CONCURRENCY: "4",
        AEGIS_TASK_RESULT_TOPIC: "direct.tasks.results",
        AEGIS_WORKER_MAX_CONCURRENT_TASKS: "2",
        WORKER_HEARTBEAT_INTERVAL_MS: "8000",
        WORKER_HEARTBEAT_TIMEOUT_MS: "24000",
        AEGIS_WORKER_HEARTBEAT_TOPIC: "direct.workers.heartbeat",
        AEGIS_WORKER_PRESENCE_CONSUMER_GROUP: "direct-presence-group",
      };

      const config = loadWorkerConfig(customEnv);
      expect(config.workerId).toBe("worker-direct-1");
      expect(config.workerName).toBe("Direct Worker");
      expect(config.maxConcurrency).toBe(4);
      expect(config.maxConcurrentTasks).toBe(2);
      expect(config.taskResultTopic).toBe("direct.tasks.results");
      expect(config.workerHeartbeatIntervalMs).toBe(8000);
      expect(config.workerHeartbeatTimeoutMs).toBe(24000);
      expect(config.workerHeartbeatTopic).toBe("direct.workers.heartbeat");
      expect(config.workerPresenceConsumerGroup).toBe("direct-presence-group");
    });
  });
});
