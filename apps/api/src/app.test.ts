import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

describe("Fastify Application Factory (buildApp)", () => {
  it("initializes fastify and attaches x-request-id header to responses", async () => {
    const app = await buildApp();

    app.get("/ping", (_req, _reply) => {
      return { pong: true };
    });

    const response = await app.inject({
      method: "GET",
      url: "/ping",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pong: true });
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-request-id"]).toBe("string");

    await app.close();
  });

  it("respects client-supplied x-request-id", async () => {
    const app = await buildApp();

    app.get("/ping", (_req, _reply) => {
      return { ok: true };
    });

    const customId = "client-req-999";
    const response = await app.inject({
      method: "GET",
      url: "/ping",
      headers: {
        "x-request-id": customId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(customId);

    await app.close();
  });

  it("configures CORS headers for cross-origin requests", async () => {
    const app = await buildApp({
      corsOrigin: "http://localhost:3000",
    });

    app.get("/ping", () => ({ ok: true }));

    const response = await app.inject({
      method: "OPTIONS",
      url: "/ping",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    await app.close();
  });
});
