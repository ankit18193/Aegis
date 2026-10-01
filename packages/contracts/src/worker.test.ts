import { workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  createWorkerError,
  isValidWorkerTransition,
  VALID_WORKER_TRANSITIONS,
  WorkerLifecycleState,
  workerCapabilitiesSchema,
  workerErrorCodeSchema,
  workerIdentitySchema,
  workerStateSchema,
} from "./worker.js";

describe("Worker Contracts & Lifecycle Schemas (Phase 11A — Commit 1)", () => {
  describe("workerStateSchema & WorkerLifecycleState", () => {
    it("validates all canonical worker states", () => {
      const states = ["starting", "ready", "draining", "stopped", "failed"] as const;
      for (const s of states) {
        expect(workerStateSchema.parse(s)).toBe(s);
      }
    });

    it("rejects unknown or invalid worker states", () => {
      expect(() => workerStateSchema.parse("idle")).toThrow();
      expect(() => workerStateSchema.parse("running")).toThrow();
      expect(() => workerStateSchema.parse("paused")).toThrow();
      expect(() => workerStateSchema.parse("")).toThrow();
    });

    it("matches WorkerLifecycleState constants", () => {
      expect(WorkerLifecycleState.STARTING).toBe("starting");
      expect(WorkerLifecycleState.READY).toBe("ready");
      expect(WorkerLifecycleState.DRAINING).toBe("draining");
      expect(WorkerLifecycleState.STOPPED).toBe("stopped");
      expect(WorkerLifecycleState.FAILED).toBe("failed");
    });
  });

  describe("isValidWorkerTransition & VALID_WORKER_TRANSITIONS", () => {
    it("allows valid forward transitions", () => {
      // starting transitions
      expect(isValidWorkerTransition("starting", "ready")).toBe(true);
      expect(isValidWorkerTransition("starting", "failed")).toBe(true);
      expect(isValidWorkerTransition("starting", "stopped")).toBe(true);

      // ready transitions
      expect(isValidWorkerTransition("ready", "draining")).toBe(true);
      expect(isValidWorkerTransition("ready", "failed")).toBe(true);

      // draining transitions
      expect(isValidWorkerTransition("draining", "stopped")).toBe(true);

      // failed transitions
      expect(isValidWorkerTransition("failed", "stopped")).toBe(true);
    });

    it("rejects invalid, backwards, or disallowed transitions", () => {
      // cannot transition from stopped to any active state
      expect(isValidWorkerTransition("stopped", "ready")).toBe(false);
      expect(isValidWorkerTransition("stopped", "starting")).toBe(false);
      expect(isValidWorkerTransition("stopped", "draining")).toBe(false);
      expect(isValidWorkerTransition("stopped", "failed")).toBe(false);

      // cannot transition backwards from ready to starting
      expect(isValidWorkerTransition("ready", "starting")).toBe(false);

      // cannot skip draining from ready directly to stopped
      expect(isValidWorkerTransition("ready", "stopped")).toBe(false);

      // cannot transition from draining back to ready
      expect(isValidWorkerTransition("draining", "ready")).toBe(false);
      expect(isValidWorkerTransition("draining", "starting")).toBe(false);

      // cannot transition to self
      expect(isValidWorkerTransition("ready", "ready")).toBe(false);
      expect(isValidWorkerTransition("starting", "starting")).toBe(false);
      expect(isValidWorkerTransition("stopped", "stopped")).toBe(false);
    });

    it("has complete mapping for all declared states in transition table", () => {
      const declaredStates = Object.keys(VALID_WORKER_TRANSITIONS);
      expect(declaredStates.sort()).toEqual(
        ["starting", "ready", "draining", "stopped", "failed"].sort(),
      );
      expect(VALID_WORKER_TRANSITIONS.stopped).toEqual([]);
    });
  });

  describe("workerCapabilitiesSchema", () => {
    it("parses valid worker capabilities", () => {
      const caps = {
        taskTypes: ["execute", "evaluate", "*"],
        tools: ["echo", "bash", "web_search"],
        maxConcurrency: 4,
      };
      const parsed = workerCapabilitiesSchema.parse(caps);
      expect(parsed).toEqual(caps);
    });

    it("rejects non-positive concurrency or empty taskTypes", () => {
      expect(() =>
        workerCapabilitiesSchema.parse({
          taskTypes: [],
          tools: [],
          maxConcurrency: 1,
        }),
      ).toThrow();

      expect(() =>
        workerCapabilitiesSchema.parse({
          taskTypes: ["execute"],
          tools: [],
          maxConcurrency: 0,
        }),
      ).toThrow();

      expect(() =>
        workerCapabilitiesSchema.parse({
          taskTypes: ["execute"],
          tools: [],
          maxConcurrency: -2,
        }),
      ).toThrow();
    });
  });

  describe("workerIdentitySchema", () => {
    it("parses valid worker identity", () => {
      const rawIdentity = {
        id: workerId("worker-dev-101"),
        name: "Worker Instance Alpha",
        startedAt: "2026-10-01T22:00:00.000Z",
        capabilities: {
          taskTypes: ["*"],
          tools: ["echo"],
          maxConcurrency: 2,
        },
      };

      const parsed = workerIdentitySchema.parse(rawIdentity);
      expect(parsed.id).toBe("worker-dev-101");
      expect(parsed.name).toBe("Worker Instance Alpha");
      expect(parsed.capabilities.maxConcurrency).toBe(2);
    });

    it("rejects invalid ISO dates or empty worker names", () => {
      expect(() =>
        workerIdentitySchema.parse({
          id: workerId("worker-test"),
          name: "",
          startedAt: "2026-10-01T22:00:00.000Z",
          capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 1 },
        }),
      ).toThrow();

      expect(() =>
        workerIdentitySchema.parse({
          id: workerId("worker-test"),
          name: "Test Worker",
          startedAt: "not-a-datetime",
          capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 1 },
        }),
      ).toThrow();
    });
  });

  describe("workerErrorCodeSchema & createWorkerError", () => {
    it("parses all canonical worker error codes", () => {
      const codes = [
        "WORKER_ALREADY_STARTED",
        "WORKER_NOT_READY",
        "WORKER_INVALID_STATE",
        "WORKER_START_FAILED",
        "WORKER_STOP_FAILED",
        "INVALID_WORKER_CONFIG",
      ] as const;

      for (const code of codes) {
        expect(workerErrorCodeSchema.parse(code)).toBe(code);
      }
    });

    it("creates structured worker error contracts", () => {
      const err = createWorkerError(
        "WORKER_INVALID_STATE",
        "Cannot transition from stopped to ready",
        new Error("State violation"),
      );
      expect(err.code).toBe("WORKER_INVALID_STATE");
      expect(err.message).toBe("Cannot transition from stopped to ready");
      expect(err.cause).toBeInstanceOf(Error);
    });
  });
});
