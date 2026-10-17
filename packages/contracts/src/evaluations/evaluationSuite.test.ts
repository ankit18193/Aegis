import { describe, expect, it } from "vitest";

import {
  evaluationCaseDefinitionSchema,
  evaluationSuiteIdSchema,
  evaluationSuiteSchema,
  existingRunTargetSchema,
} from "./evaluationSuite.js";

describe("Evaluation Suite & Case Contract Schemas", () => {
  describe("evaluationSuiteIdSchema", () => {
    it("parses valid suite identifier", () => {
      expect(evaluationSuiteIdSchema.parse("suite-core-001")).toBe("suite-core-001");
    });

    it("rejects empty suite identifier", () => {
      expect(() => evaluationSuiteIdSchema.parse("")).toThrow();
    });
  });

  describe("existingRunTargetSchema", () => {
    it("parses target with runId only", () => {
      const target = existingRunTargetSchema.parse({
        type: "existing_run",
        runId: "run-abc-123",
      });
      expect(target.type).toBe("existing_run");
      expect(target.runId).toBe("run-abc-123");
      expect(target.taskId).toBeUndefined();
    });

    it("parses target with runId and taskId", () => {
      const target = existingRunTargetSchema.parse({
        type: "existing_run",
        runId: "run-abc-123",
        taskId: "task-001",
      });
      expect(target.runId).toBe("run-abc-123");
      expect(target.taskId).toBe("task-001");
    });

    it("rejects missing runId or wrong type", () => {
      expect(() =>
        existingRunTargetSchema.parse({
          type: "scenario",
          runId: "run-123",
        }),
      ).toThrow();

      expect(() =>
        existingRunTargetSchema.parse({
          type: "existing_run",
          runId: "",
        }),
      ).toThrow();
    });
  });

  describe("evaluationCaseDefinitionSchema", () => {
    it("parses valid case definition with defaults", () => {
      const caseDef = evaluationCaseDefinitionSchema.parse({
        id: "case-01",
        name: "Verify JSON Output Compliance",
        target: {
          type: "existing_run",
          runId: "run-target-1",
        },
        evaluatorId: "evaluator-json-schema",
      });

      expect(caseDef.id).toBe("case-01");
      expect(caseDef.name).toBe("Verify JSON Output Compliance");
      expect(caseDef.description).toBe("");
      expect(caseDef.target.runId).toBe("run-target-1");
      expect(caseDef.evaluatorId).toBe("evaluator-json-schema");
    });

    it("parses case with evaluatorConfig and expectedOutcome", () => {
      const caseDef = evaluationCaseDefinitionSchema.parse({
        id: "case-02",
        name: "Check Latency and Tool Usage",
        description: "Ensures agent completes within 5s using query tool",
        target: {
          type: "existing_run",
          runId: "run-target-2",
        },
        evaluatorId: "evaluator-tool-checker",
        evaluatorConfig: { allowRetries: false },
        expectedOutcome: {
          requiredTools: ["web_search"],
          maxDurationMs: 5000,
        },
      });

      expect(caseDef.expectedOutcome?.requiredTools).toEqual(["web_search"]);
      expect(caseDef.expectedOutcome?.maxDurationMs).toBe(5000);
      expect(caseDef.evaluatorConfig?.["allowRetries"]).toBe(false);
    });

    it("rejects empty case name", () => {
      expect(() =>
        evaluationCaseDefinitionSchema.parse({
          id: "case-bad",
          name: "   ",
          target: { type: "existing_run", runId: "run-1" },
          evaluatorId: "evaluator-1",
        }),
      ).toThrow();
    });
  });

  describe("evaluationSuiteSchema", () => {
    it("parses valid immutable suite snapshot", () => {
      const suite = evaluationSuiteSchema.parse({
        id: "suite-prod-benchmark",
        version: 1,
        name: "Production Benchmark Suite",
        description: "Core quality tests across tool calling and schema compliance",
        createdAt: "2026-10-17T10:00:00.000Z",
        cases: [
          {
            id: "case-01",
            name: "Case 1",
            target: { type: "existing_run", runId: "run-1" },
            evaluatorId: "evaluator-exact-match",
          },
        ],
      });

      expect(suite.id).toBe("suite-prod-benchmark");
      expect(suite.version).toBe(1);
      expect(suite.cases).toHaveLength(1);
      expect(suite.cases[0]?.id).toBe("case-01");
    });

    it("rejects non-positive suite version", () => {
      expect(() =>
        evaluationSuiteSchema.parse({
          id: "suite-01",
          version: 0,
          name: "Invalid Suite",
          createdAt: "2026-10-17T10:00:00.000Z",
          cases: [],
        }),
      ).toThrow();

      expect(() =>
        evaluationSuiteSchema.parse({
          id: "suite-01",
          version: -1,
          name: "Negative Version",
          createdAt: "2026-10-17T10:00:00.000Z",
          cases: [],
        }),
      ).toThrow();

      expect(() =>
        evaluationSuiteSchema.parse({
          id: "suite-01",
          version: 1.5,
          name: "Float Version",
          createdAt: "2026-10-17T10:00:00.000Z",
          cases: [],
        }),
      ).toThrow();
    });

    it("rejects invalid ISO 8601 createdAt timestamp", () => {
      expect(() =>
        evaluationSuiteSchema.parse({
          id: "suite-01",
          version: 1,
          name: "Suite",
          createdAt: "not-a-timestamp",
          cases: [],
        }),
      ).toThrow();
    });
  });
});
