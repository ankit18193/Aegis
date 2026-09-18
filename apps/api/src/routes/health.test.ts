import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

describe("Health & Readiness Endpoints", () => {
  it("GET /health returns 200 OK with platform health envelope", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      timestamp: string;
      components: { name: string; status: string; message?: string }[];
    }>();

    expect(body.status).toBe("healthy");
    expect(body.timestamp).toBeDefined();
    expect(Array.isArray(body.components)).toBe(true);
    expect(body.components.some((c) => c.name === "api" && c.status === "healthy")).toBe(true);
    expect(response.headers["x-request-id"]).toBeDefined();

    await app.close();
  });

  it("GET /ready returns 200 OK when API is ready to accept traffic", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      components: { name: string; status: string; message?: string }[];
    }>();

    expect(body.status).toBe("healthy");
    expect(body.components.some((c) => c.name === "api" && c.status === "healthy")).toBe(true);

    await app.close();
  });
});
