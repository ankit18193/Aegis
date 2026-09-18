import type {
  ApiErrorResponse,
  CancelRunResponse,
  CreateRunResponse,
  GetRunResponse,
  IRunApiClient,
  ListRunsResponse,
} from "@aegis/contracts";
import { err, ok } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runService, setApiClient, setUseMock } from "./runService";

describe("runService", () => {
  let listRunsMock = vi.fn<IRunApiClient["listRuns"]>();
  let getRunMock = vi.fn<IRunApiClient["getRun"]>();
  let createRunMock = vi.fn<IRunApiClient["createRun"]>();
  let cancelRunMock = vi.fn<IRunApiClient["cancelRun"]>();
  let getRunEventsMock = vi.fn<IRunApiClient["getRunEvents"]>();

  beforeEach(() => {
    listRunsMock = vi.fn<IRunApiClient["listRuns"]>();
    getRunMock = vi.fn<IRunApiClient["getRun"]>();
    createRunMock = vi.fn<IRunApiClient["createRun"]>();
    cancelRunMock = vi.fn<IRunApiClient["cancelRun"]>();
    getRunEventsMock = vi.fn<IRunApiClient["getRunEvents"]>();

    const mockApiClient: IRunApiClient = {
      listRuns: (query) => listRunsMock(query),
      getRun: (id) => getRunMock(id),
      createRun: (req) => createRunMock(req),
      cancelRun: (id, req) => cancelRunMock(id, req),
      getRunEvents: (runId, query) => getRunEventsMock(runId, query),
    };
    setApiClient(mockApiClient);
  });

  afterEach(() => {
    setUseMock(null);
  });

  describe("when mock mode is active (default in test mode)", () => {
    it("returns seeded runs from mockRunRepository", async () => {
      setUseMock(true);
      const runs = await runService.getRuns();

      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.id).toBe("run-001");
      expect(listRunsMock).not.toHaveBeenCalled();
    });

    it("retrieves a single run by ID from mockRunRepository", async () => {
      setUseMock(true);
      const run = await runService.getRun("run-001");

      expect(run).toBeDefined();
      expect(run?.id).toBe("run-001");
      expect(getRunMock).not.toHaveBeenCalled();
    });
  });

  describe("when HTTP API client mode is active", () => {
    it("queries IRunApiClient.listRuns and returns items", async () => {
      setUseMock(false);
      const mockResponse: ListRunsResponse = {
        items: [
          {
            id: "run-http-1" as never,
            status: "running",
            goal: "HTTP Run goal",
            progress: 50,
            totalTasks: 4,
            completedTasks: 2,
            createdAt: "2026-09-18T10:00:00.000Z",
            updatedAt: "2026-09-18T10:05:00.000Z",
          },
        ],
        totalCount: 1,
      };
      listRunsMock.mockResolvedValue(ok(mockResponse));

      const runs = await runService.getRuns();

      expect(listRunsMock).toHaveBeenCalledTimes(1);
      expect(runs.length).toBe(1);
      expect(runs[0]?.id).toBe("run-http-1");
    });

    it("queries IRunApiClient.getRun and returns run details", async () => {
      setUseMock(false);
      const mockRunData: GetRunResponse = {
        run: {
          id: "run-http-1" as never,
          status: "completed",
          goal: "HTTP Run Goal",
          progress: 100,
          workflow: {
            id: "wf-1" as never,
            name: "HTTP Workflow",
            tasks: [],
          },
          tasks: [],
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:10:00.000Z",
        },
      };
      getRunMock.mockResolvedValue(ok(mockRunData));

      const run = await runService.getRun("run-http-1");

      expect(getRunMock).toHaveBeenCalledWith("run-http-1");
      expect(run?.id).toBe("run-http-1");
      expect(run?.status).toBe("completed");
    });

    it("returns null when IRunApiClient returns 404 NOT_FOUND", async () => {
      setUseMock(false);
      const notFoundError: ApiErrorResponse = {
        error: {
          code: "NOT_FOUND",
          message: "Run not found",
        },
      };
      getRunMock.mockResolvedValue(err(notFoundError));

      const run = await runService.getRun("run-missing");

      expect(getRunMock).toHaveBeenCalledWith("run-missing");
      expect(run).toBeNull();
    });

    it("submits run to IRunApiClient.createRun", async () => {
      setUseMock(false);
      const createResponse: CreateRunResponse = {
        run: {
          id: "run-new-123" as never,
          status: "pending",
          goal: "Created via client",
          progress: 0,
          workflow: {
            id: "wf-std" as never,
            name: "Standard Workflow",
            tasks: [],
          },
          tasks: [],
          createdAt: "2026-09-18T12:00:00.000Z",
          updatedAt: "2026-09-18T12:00:00.000Z",
        },
      };
      createRunMock.mockResolvedValue(ok(createResponse));

      const run = await runService.createRun({ goal: "Created via client" });

      expect(createRunMock).toHaveBeenCalledWith({
        goal: "Created via client",
      });
      expect(run.id).toBe("run-new-123");
    });

    it("cancels a run via IRunApiClient.cancelRun", async () => {
      setUseMock(false);
      const cancelResponse: CancelRunResponse = {
        run: {
          id: "run-http-1" as never,
          status: "cancelled",
          goal: "HTTP Run",
          progress: 20,
          workflow: {
            id: "wf-1" as never,
            name: "Workflow",
            tasks: [],
          },
          tasks: [],
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:05:00.000Z",
        },
      };
      cancelRunMock.mockResolvedValue(ok(cancelResponse));

      const run = await runService.cancelRun("run-http-1", "Manual stop");

      expect(cancelRunMock).toHaveBeenCalledWith("run-http-1", {
        reason: "Manual stop",
      });
      expect(run.status).toBe("cancelled");
    });

    it("falls back to local mock repository when API returns SERVICE_UNAVAILABLE", async () => {
      setUseMock(false);
      const unavailableError: ApiErrorResponse = {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Failed to fetch backend service",
        },
      };
      listRunsMock.mockResolvedValue(err(unavailableError));

      const runs = await runService.getRuns();

      expect(listRunsMock).toHaveBeenCalled();
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.id).toBe("run-001");
    });
  });
});
