import type {
  ApiErrorResponse,
  CancelRunResponse,
  CreateRunResponse,
  GetRunEventsResponse,
  GetRunResponse,
  ListRunsResponse,
} from "@aegis/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

describe("Run & Event HTTP Routes (/runs)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /runs", () => {
    it("returns 200 OK with list of seeded runs", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<ListRunsResponse>();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBe(4);
      expect(data.totalCount).toBe(4);
      expect(data.items[0]?.id).toBeDefined();
      expect(data.items[0]?.goal).toBeDefined();
    });

    it("filters runs by status", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs?status=running",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<ListRunsResponse>();
      expect(data.items.length).toBe(1);
      expect(data.items[0]?.id).toBe("run-001");
      expect(data.items[0]?.status).toBe("running");
    });

    it("filters runs by search query", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs?query=zero-trust",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<ListRunsResponse>();
      expect(data.items.length).toBe(1);
      expect(data.items[0]?.id).toBe("run-002");
    });

    it("respects pagination limit and provides nextCursor", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs?limit=2",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<ListRunsResponse>();
      expect(data.items.length).toBe(2);
      expect(data.nextCursor).toBe(data.items[1]?.id);
    });

    it("rejects invalid limit exceeding 100 with VALIDATION_ERROR", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs?limit=150",
      });

      expect(response.statusCode).toBe(400);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.details).toBeDefined();
      expect(err.error.details?.some((d) => d.field === "limit")).toBe(true);
    });
  });

  describe("POST /runs", () => {
    it("creates a new run and returns 201 Created", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          goal: "Inspect edge network telemetry for distributed packet loss spikes",
        },
      });

      expect(response.statusCode).toBe(201);
      const data = response.json<CreateRunResponse>();
      expect(data.run.id).toMatch(/^run-/);
      expect(data.run.status).toBe("pending");
      expect(data.run.progress).toBe(0);
      expect(data.run.tasks.length).toBe(4);

      // Verify the new run can be fetched via GET /runs/:runId
      const getResponse = await app.inject({
        method: "GET",
        url: `/runs/${data.run.id}`,
      });
      expect(getResponse.statusCode).toBe(200);
    });

    it("rejects goal with less than 3 characters with 400 VALIDATION_ERROR", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          goal: "ab",
        },
      });

      expect(response.statusCode).toBe(400);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.details?.some((d) => d.field === "goal")).toBe(true);
    });

    it("rejects goal with greater than 1000 characters with 400 VALIDATION_ERROR", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          goal: "a".repeat(1001),
        },
      });

      expect(response.statusCode).toBe(400);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /runs/:runId", () => {
    it("returns 200 OK with full details for valid run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/run-001",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<GetRunResponse>();
      expect(data.run.id).toBe("run-001");
      expect(data.run.status).toBe("running");
      expect(data.run.workflow.name).toBe("Repository Performance Analysis Pipeline");
      expect(data.run.tasks.length).toBe(5);
    });

    it("returns 404 NOT_FOUND for non-existent run ID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/run-non-existent",
      });

      expect(response.statusCode).toBe(404);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("NOT_FOUND");
      expect(err.error.message).toContain("run-non-existent");
    });
  });

  describe("POST /runs/:runId/cancel", () => {
    it("cancels an active running run and returns 200 OK", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs/run-001/cancel",
        payload: {
          reason: "Manual operator cancellation",
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<CancelRunResponse>();
      expect(data.run.status).toBe("cancelled");

      // Verify status persisted
      const verifyResponse = await app.inject({
        method: "GET",
        url: "/runs/run-001",
      });
      expect(verifyResponse.json<GetRunResponse>().run.status).toBe("cancelled");
    });

    it("returns 409 CONFLICT when attempting to cancel an already completed run", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs/run-002/cancel",
      });

      expect(response.statusCode).toBe(409);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("CONFLICT");
      expect(err.error.message).toContain("terminal status 'completed'");
    });

    it("returns 404 NOT_FOUND when attempting to cancel non-existent run", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/runs/run-unknown/cancel",
      });

      expect(response.statusCode).toBe(404);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /runs/:runId/events", () => {
    it("returns 200 OK with chronological timeline events", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/run-001/events",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<GetRunEventsResponse>();
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events[0]?.type).toBe("run_created");
      expect(data.events[0]?.runId).toBe("run-001");
    });

    it("filters timeline events by severity", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/run-001/events?severity=success",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json<GetRunEventsResponse>();
      expect(data.events.every((e) => e.severity === "success")).toBe(true);
    });

    it("returns 404 NOT_FOUND for events of non-existent run", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/run-unknown/events",
      });

      expect(response.statusCode).toBe(404);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Standard 404 Not Found Handler", () => {
    it("returns standardized ApiErrorResponse envelope for unknown routes", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v99/unknown-resource",
      });

      expect(response.statusCode).toBe(404);
      const err = response.json<ApiErrorResponse>();
      expect(err.error.code).toBe("NOT_FOUND");
      expect(err.error.message).toContain("route not found");
      expect(response.headers["x-request-id"]).toBeDefined();
    });
  });
});
