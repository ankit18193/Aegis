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

describe("API Foundation End-to-End Run Lifecycle Integration", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("executes the full end-to-end execution run lifecycle with trace propagation", async () => {
    const correlationId = "req-test-lifecycle-e2e-001";

    // 1. Verify system readiness
    const readyRes = await app.inject({
      method: "GET",
      url: "/ready",
      headers: { "x-request-id": correlationId },
    });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.headers["x-request-id"]).toBe(correlationId);

    // 2. Query initial seeded runs
    const initialListRes = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { "x-request-id": correlationId },
    });
    expect(initialListRes.statusCode).toBe(200);
    const initialList = initialListRes.json<ListRunsResponse>();
    const initialCount = initialList.totalCount;
    expect(initialCount).toBe(4);

    // 3. Create a new execution run
    const createRes = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-request-id": correlationId },
      payload: {
        goal: "Deploy edge telemetry probes across canary regions",
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.headers["x-request-id"]).toBe(correlationId);
    const createdData = createRes.json<CreateRunResponse>();
    const newRunId = createdData.run.id;
    expect(newRunId).toBeDefined();
    expect(createdData.run.status).toBe("pending");
    expect(createdData.run.progress).toBe(0);
    expect(createdData.run.tasks.length).toBe(4);

    // 4. Verify totalCount incremented and run appears in list
    const updatedListRes = await app.inject({
      method: "GET",
      url: "/runs",
    });
    expect(updatedListRes.statusCode).toBe(200);
    const updatedList = updatedListRes.json<ListRunsResponse>();
    expect(updatedList.totalCount).toBe((initialCount ?? 0) + 1);
    expect(updatedList.items.some((r) => r.id === newRunId)).toBe(true);

    // 5. Fetch full run details by ID
    const getRes = await app.inject({
      method: "GET",
      url: `/runs/${newRunId}`,
    });
    expect(getRes.statusCode).toBe(200);
    const getData = getRes.json<GetRunResponse>();
    expect(getData.run.id).toBe(newRunId);
    expect(getData.run.goal).toBe("Deploy edge telemetry probes across canary regions");
    expect(getData.run.workflow.name).toBe("Autonomous Execution Plan");

    // 6. Fetch timeline events for new run
    const eventsRes = await app.inject({
      method: "GET",
      url: `/runs/${newRunId}/events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    const eventsData = eventsRes.json<GetRunEventsResponse>();
    expect(eventsData.events.length).toBeGreaterThan(0);
    expect(eventsData.events.some((e) => e.type === "run_created")).toBe(true);

    // 7. Cancel the active execution run
    const cancelRes = await app.inject({
      method: "POST",
      url: `/runs/${newRunId}/cancel`,
      headers: { "x-request-id": correlationId },
      payload: {
        reason: "Canary probe threshold exceeded",
      },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.headers["x-request-id"]).toBe(correlationId);
    const cancelData = cancelRes.json<CancelRunResponse>();
    expect(cancelData.run.status).toBe("cancelled");

    // 8. Verify the run details reflect the cancelled status
    const verifiedGetRes = await app.inject({
      method: "GET",
      url: `/runs/${newRunId}`,
    });
    expect(verifiedGetRes.statusCode).toBe(200);
    expect(verifiedGetRes.json<GetRunResponse>().run.status).toBe("cancelled");

    // 9. Verify run_cancelled event was emitted in the timeline
    const updatedEventsRes = await app.inject({
      method: "GET",
      url: `/runs/${newRunId}/events`,
    });
    expect(updatedEventsRes.statusCode).toBe(200);
    const updatedEvents = updatedEventsRes.json<GetRunEventsResponse>();
    const cancelEvent = updatedEvents.events.find((e) => e.type === "run_cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.severity).toBe("warn");
    expect(cancelEvent?.message).toContain("Canary probe threshold exceeded");

    // 10. Verify attempting to cancel already cancelled run fails with 409 CONFLICT
    const duplicateCancelRes = await app.inject({
      method: "POST",
      url: `/runs/${newRunId}/cancel`,
      headers: { "x-request-id": correlationId },
      payload: {
        reason: "Second cancellation attempt",
      },
    });
    expect(duplicateCancelRes.statusCode).toBe(409);
    expect(duplicateCancelRes.headers["x-request-id"]).toBe(correlationId);
    const conflictError = duplicateCancelRes.json<ApiErrorResponse>();
    expect(conflictError.error.code).toBe("CONFLICT");
    expect(conflictError.error.message).toContain("terminal status 'cancelled'");

    // 11. Verify query filter by cancelled status returns the cancelled run
    const filteredRunsRes = await app.inject({
      method: "GET",
      url: "/runs?status=cancelled",
    });
    expect(filteredRunsRes.statusCode).toBe(200);
    const filteredRuns = filteredRunsRes.json<ListRunsResponse>();
    expect(filteredRuns.items.some((r) => r.id === newRunId)).toBe(true);
  });
});
