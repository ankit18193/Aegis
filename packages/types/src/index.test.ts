import { describe, expect, it } from "vitest";

import {
  agentId,
  AgentStatus,
  err,
  evaluationCaseId,
  evaluationResultId,
  evaluationRunId,
  evaluationSuiteId,
  evaluatorId,
  eventId,
  ok,
  runId,
  taskId,
  workerId,
  workflowId,
  WorkflowStatus,
} from "./index.js";

describe("@aegis/types Domain Primitives", () => {
  describe("Branded Identifiers", () => {
    it("creates branded RunId and EventId", () => {
      const rId = runId("run-12345");
      const eId = eventId("ev-98765");

      expect(rId).toBe("run-12345");
      expect(eId).toBe("ev-98765");
      expect(typeof rId).toBe("string");
      expect(typeof eId).toBe("string");
    });

    it("creates branded AgentId, WorkflowId, TaskId, and WorkerId", () => {
      const aId = agentId("agent-001");
      const wfId = workflowId("wf-001");
      const tId = taskId("task-001");
      const wId = workerId("worker-alpha");

      expect(aId).toBe("agent-001");
      expect(wfId).toBe("wf-001");
      expect(tId).toBe("task-001");
      expect(wId).toBe("worker-alpha");
    });

    it("creates branded Evaluation domain identifiers", () => {
      const sId = evaluationSuiteId("suite-100");
      const cId = evaluationCaseId("case-200");
      const erId = evaluationRunId("evalrun-300");
      const resId = evaluationResultId("evalres-400");
      const evId = evaluatorId("evaluator-exact-match");

      expect(sId).toBe("suite-100");
      expect(cId).toBe("case-200");
      expect(erId).toBe("evalrun-300");
      expect(resId).toBe("evalres-400");
      expect(evId).toBe("evaluator-exact-match");
      expect(typeof sId).toBe("string");
      expect(typeof cId).toBe("string");
      expect(typeof erId).toBe("string");
      expect(typeof resId).toBe("string");
      expect(typeof evId).toBe("string");
    });
  });

  describe("Enums & Statuses", () => {
    it("defines valid AgentStatus values", () => {
      expect(AgentStatus.Pending).toBe("pending");
      expect(AgentStatus.Running).toBe("running");
      expect(AgentStatus.Completed).toBe("completed");
      expect(AgentStatus.Failed).toBe("failed");
      expect(AgentStatus.Cancelled).toBe("cancelled");
    });

    it("defines valid WorkflowStatus values", () => {
      expect(WorkflowStatus.Draft).toBe("draft");
      expect(WorkflowStatus.Active).toBe("active");
      expect(WorkflowStatus.Paused).toBe("paused");
      expect(WorkflowStatus.Completed).toBe("completed");
      expect(WorkflowStatus.Failed).toBe("failed");
      expect(WorkflowStatus.Cancelled).toBe("cancelled");
    });
  });

  describe("Result Utilities", () => {
    it("creates successful Result via ok()", () => {
      const success = ok({ id: "run-001" });
      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.value).toEqual({ id: "run-001" });
      }
    });

    it("creates failure Result via err()", () => {
      const failure = err(new Error("Operation failed"));
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error.message).toBe("Operation failed");
      }
    });
  });
});
