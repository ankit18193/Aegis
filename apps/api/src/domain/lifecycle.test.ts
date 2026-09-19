import { describe, expect, it } from "vitest";

import { InvalidStateTransitionError, TerminalStateError } from "./errors.js";
import {
  assertValidRunTransition,
  assertValidTaskTransition,
  canTransitionRun,
  canTransitionTask,
  isTerminalRunStatus,
  isTerminalTaskStatus,
} from "./lifecycle.js";
import type { RunStatus, TaskStatus } from "./lifecycle.js";

describe("Domain Lifecycle State Machines", () => {
  describe("Run Lifecycle", () => {
    it("allows legal run transitions", () => {
      expect(canTransitionRun("pending", "running")).toBe(true);
      expect(canTransitionRun("pending", "cancelled")).toBe(true);
      expect(canTransitionRun("running", "completed")).toBe(true);
      expect(canTransitionRun("running", "failed")).toBe(true);
      expect(canTransitionRun("running", "cancelled")).toBe(true);

      const res = assertValidRunTransition("pending", "running");
      expect(res.ok).toBe(true);
    });

    it("rejects illegal run transitions", () => {
      expect(canTransitionRun("pending", "completed")).toBe(false);
      expect(canTransitionRun("pending", "failed")).toBe(false);
      expect(canTransitionRun("running", "pending")).toBe(false);

      const res = assertValidRunTransition("pending", "completed");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(InvalidStateTransitionError);
        expect(res.error.code).toBe("INVALID_STATE_TRANSITION");
      }
    });

    it("enforces terminal run immutability with TerminalStateError", () => {
      const terminalStatuses: RunStatus[] = ["completed", "failed", "cancelled"];
      const allStatuses: RunStatus[] = ["pending", "running", "completed", "failed", "cancelled"];

      for (const term of terminalStatuses) {
        expect(isTerminalRunStatus(term)).toBe(true);
        for (const target of allStatuses) {
          expect(canTransitionRun(term, target)).toBe(false);
          const res = assertValidRunTransition(term, target);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.error).toBeInstanceOf(TerminalStateError);
            expect(res.error.code).toBe("TERMINAL_STATE_ERROR");
          }
        }
      }
    });
  });

  describe("Task Lifecycle (Phase 4)", () => {
    it("allows legal task transitions", () => {
      expect(canTransitionTask("pending", "queued")).toBe(true);
      expect(canTransitionTask("pending", "cancelled")).toBe(true);
      expect(canTransitionTask("queued", "running")).toBe(true);
      expect(canTransitionTask("queued", "failed")).toBe(true);
      expect(canTransitionTask("queued", "cancelled")).toBe(true);
      expect(canTransitionTask("running", "completed")).toBe(true);
      expect(canTransitionTask("running", "failed")).toBe(true);
      expect(canTransitionTask("running", "cancelled")).toBe(true);

      const res = assertValidTaskTransition("pending", "queued");
      expect(res.ok).toBe(true);
    });

    it("rejects illegal task transitions", () => {
      expect(canTransitionTask("pending", "running")).toBe(false);
      expect(canTransitionTask("pending", "completed")).toBe(false);
      expect(canTransitionTask("queued", "completed")).toBe(false);
      expect(canTransitionTask("running", "pending")).toBe(false);
      expect(canTransitionTask("running", "queued")).toBe(false);

      const res = assertValidTaskTransition("pending", "running");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(InvalidStateTransitionError);
        expect(res.error.code).toBe("INVALID_STATE_TRANSITION");
      }
    });

    it("enforces terminal task immutability with TerminalStateError", () => {
      const terminalStatuses: TaskStatus[] = ["completed", "failed", "cancelled"];
      const allStatuses: TaskStatus[] = [
        "pending",
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
      ];

      for (const term of terminalStatuses) {
        expect(isTerminalTaskStatus(term)).toBe(true);
        for (const target of allStatuses) {
          expect(canTransitionTask(term, target)).toBe(false);
          const res = assertValidTaskTransition(term, target);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.error).toBeInstanceOf(TerminalStateError);
            expect(res.error.code).toBe("TERMINAL_STATE_ERROR");
          }
        }
      }
    });
  });
});
