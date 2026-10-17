import type {
  EvaluationCaseDefinition,
  EvaluationSuite,
  Run,
  RunEvent,
} from "@aegis/contracts";
import {
  evaluationCaseId,
  evaluationRunId,
  evaluationSuiteId,
  evaluatorId,
  eventId,
  runId,
} from "@aegis/types";
import { describe, expect, it } from "vitest";

import { DeterministicEvaluationEngine } from "./engine.js";
import { ExactMatchEvaluator } from "./evaluators/exactMatchEvaluator.js";
import { RunLifecycleEvaluator } from "./evaluators/runLifecycleEvaluator.js";
import { InMemoryEvidenceProvider } from "./evidence.js";
import { EvaluatorRegistry } from "./registry.js";

function buildMockRun(params?: {
  id?: string;
  summary?: string;
  status?: Run["status"];
  durationMs?: number;
}): Run {
  return {
    id: runId(params?.id ?? "run-engine-1"),
    goal: "Test engine execution",
    status: params?.status ?? "completed",
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:05.000Z",
    progress: 100,
    workflow: { id: "wf-1" as never, name: "Test Workflow", tasks: [] },
    tasks: [],
    result: {
      summary: params?.summary ?? "Order placed successfully",
      metrics: {
        durationMs: params?.durationMs ?? 5000,
        tasksTotal: 1,
        tasksCompleted: 1,
        toolInvocations: 1,
      },
    },
  };
}

describe("DeterministicEvaluationEngine (Phase 14B — Milestone 4)", () => {
  function setupEngine() {
    const registry = new EvaluatorRegistry();
    const evidenceProvider = new InMemoryEvidenceProvider();
    const engine = new DeterministicEvaluationEngine(registry, evidenceProvider);

    // Register standard evaluators
    registry.register(new ExactMatchEvaluator());
    registry.register(new RunLifecycleEvaluator());

    return { registry, evidenceProvider, engine };
  }

  describe("evaluateCase", () => {
    it("evaluates a case to pass when output matches expectations", async () => {
      const { evidenceProvider, engine } = setupEngine();
      const run = buildMockRun({ summary: "Hello World" });
      evidenceProvider.setRunEvidence(run);

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-1"),
        name: "Test Greeting Match",
        description: "Verifies greeting output",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: {
          expectedPattern: "Hello World",
          matchMode: "exact",
        },
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
        captureRawOutput: true,
      });

      expect(result.lifecycleStatus).toBe("completed");
      expect(result.outcome?.verdict).toBe("pass");
      expect(result.outcome?.score).toBe(1.0);
      expect(result.evaluatorVersion).toBe("1.0.0");
      expect(result.outcome?.evidence.rawOutputSnippet).toBe("Hello World");
    });

    it("evaluates a case to fail when assertion fails", async () => {
      const { evidenceProvider, engine } = setupEngine();
      const run = buildMockRun({ summary: "Payment Failed" });
      evidenceProvider.setRunEvidence(run);

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-2"),
        name: "Test Payment Success",
        description: "Verifies payment success output",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: {
          expectedPattern: "Payment Succeeded",
          matchMode: "exact",
        },
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(result.lifecycleStatus).toBe("completed");
      expect(result.outcome?.verdict).toBe("fail");
      expect(result.outcome?.score).toBe(0.0);
      expect(result.outcome?.failureClassification).toBe("assertion_failed");
    });

    it("returns evaluator_error when evaluator is not registered", async () => {
      const { evidenceProvider, engine } = setupEngine();
      const run = buildMockRun();
      evidenceProvider.setRunEvidence(run);

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-3"),
        name: "Unregistered Evaluator Case",
        description: "",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("non_existent_evaluator"),
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(result.lifecycleStatus).toBe("completed");
      expect(result.outcome?.verdict).toBe("error");
      expect(result.outcome?.score).toBeNull();
      expect(result.outcome?.failureClassification).toBe("evaluator_error");
      expect(result.outcome?.reason).toContain("is not registered");
    });

    it("returns missing_evidence when run evidence is not found", async () => {
      const { engine } = setupEngine();

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-4"),
        name: "Missing Evidence Case",
        description: "",
        target: { type: "existing_run", runId: runId("run-ghost") },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: { expectedPattern: "Test" },
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(result.lifecycleStatus).toBe("completed");
      expect(result.outcome?.verdict).toBe("error");
      expect(result.outcome?.score).toBeNull();
      expect(result.outcome?.failureClassification).toBe("missing_evidence");
      expect(result.outcome?.reason).toContain("not found in evidence provider");
    });

    it("enforces evaluator version pinning from evaluatorConfig", async () => {
      const { registry, evidenceProvider, engine } = setupEngine();
      const run = buildMockRun({ summary: "Version Pin Test" });
      evidenceProvider.setRunEvidence(run);

      // Register v2 of exact_match
      registry.register({
        id: evaluatorId("exact_match"),
        version: "2.0.0",
        kind: "deterministic",
        metricType: "binary",
        evaluate: () =>
          Promise.resolve({
            ok: true,
            value: {
              verdict: "pass",
              score: 1.0,
              reason: "v2 pass",
              assertions: [],
            },
          }),
      });

      // Pin to 1.0.0
      const caseDefV1: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-v1"),
        name: "Case pinned to 1.0.0",
        description: "",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: {
          evaluatorVersion: "1.0.0",
          expectedPattern: "Version Pin Test",
        },
      };

      const resultV1 = await engine.evaluateCase({
        caseDef: caseDefV1,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(resultV1.evaluatorVersion).toBe("1.0.0");

      // Pin to 2.0.0
      const caseDefV2: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-eng-v2"),
        name: "Case pinned to 2.0.0",
        description: "",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: {
          evaluatorVersion: "2.0.0",
        },
      };

      const resultV2 = await engine.evaluateCase({
        caseDef: caseDefV2,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(resultV2.evaluatorVersion).toBe("2.0.0");
      expect(resultV2.outcome?.reason).toBe("v2 pass");
    });

    it("isolates uncaught exceptions thrown inside evaluator evaluate method", async () => {
      const { registry, evidenceProvider, engine } = setupEngine();
      const run = buildMockRun();
      evidenceProvider.setRunEvidence(run);

      registry.register({
        id: evaluatorId("exploding_evaluator"),
        version: "1.0.0",
        kind: "deterministic",
        metricType: "binary",
        evaluate: () => {
          throw new Error("Catastrophic evaluator bug");
        },
      });

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-exploding"),
        name: "Exploding Case",
        description: "",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exploding_evaluator"),
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
      });

      expect(result.lifecycleStatus).toBe("completed");
      expect(result.outcome?.verdict).toBe("error");
      expect(result.outcome?.failureClassification).toBe("evaluator_error");
      expect(result.outcome?.reason).toContain("Uncaught evaluator exception: Catastrophic evaluator bug");
    });

    it("handles pre-aborted signal by returning skipped verdict with 0 duration", async () => {
      const { evidenceProvider, engine } = setupEngine();
      const run = buildMockRun();
      evidenceProvider.setRunEvidence(run);

      const controller = new AbortController();
      controller.abort();

      const caseDef: EvaluationCaseDefinition = {
        id: evaluationCaseId("case-aborted"),
        name: "Aborted Case",
        description: "",
        target: { type: "existing_run", runId: run.id },
        evaluatorId: evaluatorId("exact_match"),
        evaluatorConfig: { expectedPattern: "test" },
      };

      const result = await engine.evaluateCase({
        caseDef,
        suiteId: evaluationSuiteId("suite-1"),
        suiteVersion: 1,
        evaluationRunId: evaluationRunId("eval-run-1"),
        abortSignal: controller.signal,
      });

      expect(result.outcome?.verdict).toBe("skipped");
      expect(result.outcome?.durationMs).toBe(0);
      expect(result.outcome?.reason).toContain("cancelled before case execution commenced");
    });
  });

  describe("evaluateSuite", () => {
    it("executes a complete suite and computes valid metrics matching the completion invariant", async () => {
      const { evidenceProvider, engine } = setupEngine();

      const runPass = buildMockRun({ id: "run-pass", summary: "Order OK" });
      const runFail = buildMockRun({ id: "run-fail", summary: "Order Error" });
      evidenceProvider.setRunEvidence(runPass);
      evidenceProvider.setRunEvidence(runFail);

      const suite: EvaluationSuite = {
        id: evaluationSuiteId("suite-full-1"),
        version: 1,
        name: "Full Suite Test",
        description: "Tests pass and fail cases",
        createdAt: "2026-10-17T12:00:00.000Z",
        cases: [
          {
            id: evaluationCaseId("case-1"),
            name: "Should pass",
            description: "",
            target: { type: "existing_run", runId: runPass.id },
            evaluatorId: evaluatorId("exact_match"),
            evaluatorConfig: { expectedPattern: "Order OK" },
          },
          {
            id: evaluationCaseId("case-2"),
            name: "Should fail",
            description: "",
            target: { type: "existing_run", runId: runFail.id },
            evaluatorId: evaluatorId("exact_match"),
            evaluatorConfig: { expectedPattern: "Order OK" },
          },
        ],
      };

      const { run, results } = await engine.evaluateSuite({ suite });

      expect(run.status).toBe("completed");
      expect(results).toHaveLength(2);
      expect(results[0]?.outcome?.verdict).toBe("pass");
      expect(results[1]?.outcome?.verdict).toBe("fail");

      // Verify terminal completion invariant: passed + failed + error + skipped === total
      const { passedCases, failedCases, errorCases, skippedCases, totalCases } = run.metrics;
      expect(passedCases + failedCases + errorCases + skippedCases).toBe(totalCases);
      expect(totalCases).toBe(2);
      expect(passedCases).toBe(1);
      expect(failedCases).toBe(1);
      expect(errorCases).toBe(0);
      expect(skippedCases).toBe(0);
      expect(run.metrics.passRate).toBe(0.5);
    });

    it("transitions suite to cancelled and marks unstarted cases skipped when aborted", async () => {
      const { registry, evidenceProvider, engine } = setupEngine();

      const run1 = buildMockRun({ id: "run-abort-1", summary: "test-1" });
      const run2 = buildMockRun({ id: "run-abort-2", summary: "test-2" });
      const run3 = buildMockRun({ id: "run-abort-3", summary: "test-3" });
      evidenceProvider.setRunEvidence(run1);
      evidenceProvider.setRunEvidence(run2);
      evidenceProvider.setRunEvidence(run3);

      const controller = new AbortController();

      // Register an evaluator that triggers abort mid-flight for case 2
      registry.register({
        id: evaluatorId("abort_trigger_evaluator"),
        version: "1.0.0",
        kind: "deterministic",
        metricType: "binary",
        evaluate: () => {
          controller.abort();
          return Promise.resolve({
            ok: true,
            value: {
              verdict: "pass",
              score: 1.0,
              reason: "aborted now",
              assertions: [],
            },
          });
        },
      });

      const suite: EvaluationSuite = {
        id: evaluationSuiteId("suite-abort-test"),
        version: 1,
        name: "Abort Suite",
        description: "",
        createdAt: "2026-10-17T12:00:00.000Z",
        cases: [
          {
            id: evaluationCaseId("case-completed-first"),
            name: "Completed First",
            description: "",
            target: { type: "existing_run", runId: run1.id },
            evaluatorId: evaluatorId("exact_match"),
            evaluatorConfig: { expectedPattern: "test-1" },
          },
          {
            id: evaluationCaseId("case-midflight-abort"),
            name: "Mid-flight Abort Case",
            description: "",
            target: { type: "existing_run", runId: run2.id },
            evaluatorId: evaluatorId("abort_trigger_evaluator"),
          },
          {
            id: evaluationCaseId("case-unstarted"),
            name: "Unstarted Case",
            description: "",
            target: { type: "existing_run", runId: run3.id },
            evaluatorId: evaluatorId("exact_match"),
            evaluatorConfig: { expectedPattern: "test-3" },
          },
        ],
      };

      const { run, results } = await engine.evaluateSuite({
        suite,
        abortSignal: controller.signal,
      });

      // Crucial Phase 14B invariant: Cancelled run is strictly marked 'cancelled' (NEVER 'completed')
      expect(run.status).toBe("cancelled");
      expect(run.failureReason).toBe("Evaluation cancelled by operator");

      expect(results).toHaveLength(3);
      // Case 1 completed normally before cancellation
      expect(results[0]?.outcome?.verdict).toBe("pass");
      // Case 2 aborted mid-flight -> marked skipped
      expect(results[1]?.outcome?.verdict).toBe("skipped");
      expect(results[1]?.outcome?.reason).toBe("Evaluation aborted mid-flight");
      // Case 3 was unstarted -> marked skipped
      expect(results[2]?.outcome?.verdict).toBe("skipped");
      expect(results[2]?.outcome?.reason).toContain("cancelled before case execution commenced");

      // Verify completion invariant still holds: passed + failed + error + skipped === total
      const { passedCases, failedCases, errorCases, skippedCases, totalCases } = run.metrics;
      expect(passedCases + failedCases + errorCases + skippedCases).toBe(totalCases);
      expect(totalCases).toBe(3);
      expect(passedCases).toBe(1);
      expect(failedCases).toBe(0);
      expect(errorCases).toBe(0);
      expect(skippedCases).toBe(2);
    });

    it("handles empty evaluation suite cleanly", async () => {
      const { engine } = setupEngine();

      const suite: EvaluationSuite = {
        id: evaluationSuiteId("suite-empty"),
        version: 1,
        name: "Empty Suite",
        description: "",
        createdAt: "2026-10-17T12:00:00.000Z",
        cases: [],
      };

      const { run, results } = await engine.evaluateSuite({ suite });

      expect(run.status).toBe("completed");
      expect(results).toHaveLength(0);
      expect(run.metrics.totalCases).toBe(0);
      expect(run.metrics.passRate).toBeNull();
    });

    it("guarantees non-mutation of inspected agent run and events", async () => {
      const { evidenceProvider, engine } = setupEngine();

      const originalRun = buildMockRun({ summary: "Immutable Test" });
      const originalEvents: RunEvent[] = [
        {
          id: eventId("evt-imm-1"),
          runId: originalRun.id,
          type: "run_created",
          severity: "info",
          message: "Run started",
          timestamp: "2026-10-17T12:00:00.000Z",
        },
      ];

      evidenceProvider.setRunEvidence(originalRun, originalEvents);

      const suite: EvaluationSuite = {
        id: evaluationSuiteId("suite-imm"),
        version: 1,
        name: "Immutability Test",
        description: "",
        createdAt: "2026-10-17T12:00:00.000Z",
        cases: [
          {
            id: evaluationCaseId("case-imm-1"),
            name: "Case 1",
            description: "",
            target: { type: "existing_run", runId: originalRun.id },
            evaluatorId: evaluatorId("exact_match"),
            evaluatorConfig: { expectedPattern: "Immutable Test" },
          },
        ],
      };

      await engine.evaluateSuite({ suite });

      // Verify original run was not mutated
      expect(originalRun.status).toBe("completed");
      expect(originalRun.result?.summary).toBe("Immutable Test");
      expect(originalEvents).toHaveLength(1);
    });
  });
});
