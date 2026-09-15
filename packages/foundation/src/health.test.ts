import { describe, expect, it } from "vitest";

import { HealthStatus, createComponentHealth, aggregatePlatformHealth } from "./health.js";

describe("createComponentHealth", () => {
  it("creates a healthy component health record", () => {
    const result = createComponentHealth("database", HealthStatus.Healthy);

    expect(result.name).toBe("database");
    expect(result.status).toBe(HealthStatus.Healthy);
    expect(result.message).toBeUndefined();
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("creates a degraded component health record with a message", () => {
    const result = createComponentHealth("cache", HealthStatus.Degraded, "High latency detected");

    expect(result.name).toBe("cache");
    expect(result.status).toBe(HealthStatus.Degraded);
    expect(result.message).toBe("High latency detected");
  });

  it("creates an unhealthy component health record", () => {
    const result = createComponentHealth("broker", HealthStatus.Unhealthy, "Connection refused");

    expect(result.status).toBe(HealthStatus.Unhealthy);
  });
});

describe("aggregatePlatformHealth", () => {
  it("returns healthy when all components are healthy", () => {
    const components = [
      createComponentHealth("api", HealthStatus.Healthy),
      createComponentHealth("database", HealthStatus.Healthy),
    ];

    const result = aggregatePlatformHealth(components);

    expect(result.status).toBe(HealthStatus.Healthy);
    expect(result.components).toHaveLength(2);
  });

  it("returns degraded when at least one component is degraded", () => {
    const components = [
      createComponentHealth("api", HealthStatus.Healthy),
      createComponentHealth("cache", HealthStatus.Degraded),
    ];

    const result = aggregatePlatformHealth(components);

    expect(result.status).toBe(HealthStatus.Degraded);
  });

  it("returns unhealthy when at least one component is unhealthy", () => {
    const components = [
      createComponentHealth("api", HealthStatus.Healthy),
      createComponentHealth("cache", HealthStatus.Degraded),
      createComponentHealth("broker", HealthStatus.Unhealthy),
    ];

    const result = aggregatePlatformHealth(components);

    expect(result.status).toBe(HealthStatus.Unhealthy);
  });

  it("returns healthy for an empty component list", () => {
    const result = aggregatePlatformHealth([]);

    expect(result.status).toBe(HealthStatus.Healthy);
    expect(result.components).toHaveLength(0);
  });

  it("includes an ISO 8601 timestamp", () => {
    const result = aggregatePlatformHealth([]);

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
