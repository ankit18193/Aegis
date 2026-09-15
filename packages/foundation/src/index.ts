/**
 * @aegis/foundation
 *
 * Shared low-level primitives for the Aegis platform.
 * This package has no dependencies on other @aegis packages.
 */

export { HealthStatus, createComponentHealth, aggregatePlatformHealth } from "./health.js";
export type { ComponentHealth, PlatformHealth } from "./health.js";

export { semver, isRecord, invariant, assertNever } from "./utils.js";
