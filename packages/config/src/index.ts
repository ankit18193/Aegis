/**
 * @aegis/config
 *
 * Centralized configuration handling for the Aegis platform.
 *
 * NOTE: This is a Phase 0 placeholder.
 * In future phases, this package will:
 * - Parse and validate environment variables (using zod or similar)
 * - Provide typed config objects to all platform components
 * - Support different config sources (env, files, remote config)
 * - Implement config hot-reloading where appropriate
 */

// ─────────────────────────────────────────────────────────────────────────────
// Environment helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported runtime environments.
 */
export type NodeEnv = "development" | "test" | "production";

/**
 * Returns the current NODE_ENV as a typed value.
 * Defaults to "development" if unset or unrecognized.
 */
export function getNodeEnv(): NodeEnv {
  const raw = process.env["NODE_ENV"];
  if (raw === "production" || raw === "test") {
    return raw;
  }
  return "development";
}

/**
 * Returns true if running in production.
 */
export function isProduction(): boolean {
  return getNodeEnv() === "production";
}

/**
 * Returns true if running in a test environment.
 */
export function isTest(): boolean {
  return getNodeEnv() === "test";
}

/**
 * Reads a required environment variable, throwing if it is not set.
 *
 * @param key - The environment variable name.
 * @throws Error if the variable is not defined.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Required environment variable "${key}" is not set.`);
  }
  return value;
}

/**
 * Reads an optional environment variable with a fallback default.
 *
 * @param key - The environment variable name.
 * @param defaultValue - Value to use when the variable is not set.
 */
export function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base application config (minimal, Phase 0)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base configuration shared across all Aegis services.
 *
 * NOTE: In future phases this will be expanded to include
 * database, cache, Kafka, AI provider, and observability configuration.
 */
export interface BaseConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: string;
}

/**
 * Reads the base configuration from the environment.
 */
export function loadBaseConfig(): BaseConfig {
  return {
    nodeEnv: getNodeEnv(),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
  };
}
