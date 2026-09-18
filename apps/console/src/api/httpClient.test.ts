import type {
  ApiErrorResponse,
  CancelRunResponse,
  CreateRunResponse,
  GetRunEventsResponse,
  GetRunResponse,
  ListRunsResponse,
} from "@aegis/contracts";
import { describe, expect, it, vi } from "vitest";

import { HttpRunApiClient } from "./httpClient";

describe("HttpRunApiClient", () => {
  const baseUrl = "http://localhost:3001";

  it("lists runs with query parameters and parses successful response", async () => {
    const mockData: ListRunsResponse = {
      items: [
        {
          id: "run-001" as never,
          status: "running",
          goal: "Inspect edge network telemetry",
          progress: 40,
          totalTasks: 5,
          completedTasks: 2,
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:05:00.000Z",
        },
      ],
      totalCount: 1,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.listRuns({ status: "running", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items.length).toBe(1);
      expect(result.value.items[0]?.id).toBe("run-001");
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/runs?status=running&limit=10",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("gets run by ID and parses successful response", async () => {
    const mockData: GetRunResponse = {
      run: {
        id: "run-001" as never,
        status: "running",
        goal: "Inspect edge network telemetry",
        progress: 40,
        workflow: {
          id: "wf-001" as never,
          name: "Test Pipeline",
          tasks: [],
        },
        tasks: [],
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:05:00.000Z",
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.getRun("run-001");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.run.id).toBe("run-001");
      expect(result.value.run.workflow.name).toBe("Test Pipeline");
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/runs/run-001",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates a new run and sends JSON payload", async () => {
    const mockData: CreateRunResponse = {
      run: {
        id: "run-999" as never,
        status: "pending",
        goal: "Automated test run",
        progress: 0,
        workflow: {
          id: "wf-default" as never,
          name: "Standard Execution Workflow",
          tasks: [],
        },
        tasks: [],
        createdAt: "2026-09-18T12:00:00.000Z",
        updatedAt: "2026-09-18T12:00:00.000Z",
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.createRun({ goal: "Automated test run" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.run.id).toBe("run-999");
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ goal: "Automated test run" }),
      }),
    );
  });

  it("cancels a run and parses response", async () => {
    const mockData: CancelRunResponse = {
      run: {
        id: "run-001" as never,
        status: "cancelled",
        goal: "Inspect edge network telemetry",
        progress: 40,
        workflow: {
          id: "wf-001" as never,
          name: "Test Pipeline",
          tasks: [],
        },
        tasks: [],
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:10:00.000Z",
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.cancelRun("run-001", { reason: "Operator cancelled" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.run.status).toBe("cancelled");
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/runs/run-001/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Operator cancelled" }),
      }),
    );
  });

  it("retrieves run events with severity query", async () => {
    const mockData: GetRunEventsResponse = {
      events: [
        {
          id: "ev-01" as never,
          runId: "run-001" as never,
          type: "run_created",
          message: "Run created",
          severity: "info",
          timestamp: "2026-09-18T10:00:00.000Z",
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.getRunEvents("run-001", { severity: "info", limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.length).toBe(1);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/runs/run-001/events?limit=50&severity=info",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("parses structured ApiErrorResponse envelopes on 400 VALIDATION_ERROR", async () => {
    const errorEnvelope: ApiErrorResponse = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed for request body",
        details: [{ field: "goal", message: "Goal must be at least 3 characters", code: "too_small" }],
        traceId: "req-123",
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve(JSON.stringify(errorEnvelope)),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.createRun({ goal: "a" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.error.details?.[0]?.field).toBe("goal");
      expect(result.error.error.traceId).toBe("req-123");
    }
  });

  it("generates fallback ApiErrorResponse when server returns non-JSON error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: () => Promise.resolve("<html>502 Bad Gateway</html>"),
    });

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.getRun("run-001");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(result.error.error.message).toBe("Bad Gateway");
    }
  });

  it("handles network failure and returns SERVICE_UNAVAILABLE error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const client = new HttpRunApiClient({ baseUrl, fetch: mockFetch });
    const result = await client.getRun("run-001");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(result.error.error.message).toBe("Failed to fetch");
    }
  });

  it("includes custom headers provided by getHeaders callback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ items: [], totalCount: 0 })),
    });

    const client = new HttpRunApiClient({
      baseUrl,
      fetch: mockFetch,
      getHeaders: () => ({ "x-custom-tenant": "tenant-abc" }),
    });

    await client.listRuns();

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe("http://localhost:3001/runs");
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["x-custom-tenant"]).toBe("tenant-abc");
  });
});
