import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getNodeEnv,
  isProduction,
  isTest,
  loadAgentConfig,
  loadBaseConfig,
  loadDatabaseConfig,
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
});
