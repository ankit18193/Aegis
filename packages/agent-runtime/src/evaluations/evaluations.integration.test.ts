import type {
  EvaluationSuite,
  Run,
  RunEvent,
} from "@aegis/contracts";
import {
  areEvaluatorMetricsComparable,
  evaluationResultSchema,
  evaluationRunSchema,
  isEvaluationRunComplete,
} from "@aegis/contracts";
import {
  evaluationCaseId,
  evaluationSuiteId,
  evaluatorId,
  eventId,
  runId,
  taskId,
} from "@aegis/types";
import { describe, expect, it } from "vitest";

import { DeterministicEvaluationEngine } from "./engine.js";
import { ExactMatchEvaluator } from "./evaluators/exactMatchEvaluator.js";
import { JsonSchemaEvaluator } from "./evaluators/jsonSchemaEvaluator.js";
import { RunLifecycleEvaluator } from "./evaluators/runLifecycleEvaluator.js";
import { ToolCallEvaluator } from "./evaluators/toolCallEvaluator.js";
import { InMemoryEvidenceProvider } from "./evidence.js";
import { EvaluatorRegistry } from "./registry.js";

function buildExecutionRun(params: {
  id: string;
  summary: string;
  status: Run["status"];
  durationMs: number;
  tasks?: Run["tasks"];
}): Run {
  return {
    id: runId(params.id),
    goal: "Deploy multi-tier application",
    status: params.status,
    createdAt: "2026-10-17T14:00:00.000Z",
    updatedAt: "2026-10-17T14:00:04.500Z",
    progress: 100,
    workflow: { id: "wf-deploy" as never, name: "Deployment Workflow", tasks: [] },
    tasks: params.tasks ?? [],
    result: {
      summary: params.summary,
      metrics: {
        durationMs: params.durationMs,
        tasksTotal: 2,
        tasksCompleted: 2,
        toolInvocations: 2,
      },
    },
  };
}

describe("Evaluations End-to-End Suite Integration (Phase 14B — Milestone 5)", () => {
  it("executes multi-evaluator suite, validates completion invariants, and satisfies contracts", async () => {
    // 1. Setup registry with all 4 deterministic evaluators
    const registry = new EvaluatorRegistry();
    const exactMatchEval = new ExactMatchEvaluator();
    const jsonSchemaEval = new JsonSchemaEvaluator();
    const toolCallEval = new ToolCallEvaluator();
    const runLifecycleEval = new RunLifecycleEvaluator();

    registry.register(exactMatchEval);
    registry.register(jsonSchemaEval);
    registry.register(toolCallEval);
    registry.register(runLifecycleEval);

    expect(registry.list()).toHaveLength(4);

    // Verify metric comparability helper
    expect(
      areEvaluatorMetricsComparable(exactMatchEval, {
        id: exactMatchEval.id,
        version: exactMatchEval.version,
        metricType: exactMatchEval.metricType,
      }),
    ).toBe(true);

    // 2. Setup mock evidence provider with realistic run data
    const evidenceProvider = new InMemoryEvidenceProvider();

    const taskBuild = {
      id: taskId("task-build"),
      name: "Build Container",
      status: "completed" as const,
      description: "Build docker container",
      version: 1,
      attemptCount: 1,
      output: JSON.stringify({ artifact: "registry.example.com/app:v1.2.0", digest: "sha256:abc12345" }),
    };

    const taskDeploy = {
      id: taskId("task-deploy"),
      name: "Deploy Service",
      status: "completed" as const,
      description: "Deploy to Kubernetes cluster",
      version: 1,
      attemptCount: 1,
      output: JSON.stringify({ cluster: "prod-us-east-1", status: "HEALTHY", replicas: 3 }),
    };

    const runSuccess = buildExecutionRun({
      id: "run-deploy-prod-001",
      summary: JSON.stringify({
        status: "SUCCESS",
        environment: "production",
        deploymentId: "dep-98765",
        replicas: 3,
      }),
      status: "completed",
      durationMs: 4500,
      tasks: [taskBuild, taskDeploy],
    });

    const eventsSuccess: RunEvent[] = [
      {
        id: eventId("evt-101"),
        runId: runSuccess.id,
        type: "tool_invoked",
        severity: "info",
        message: "Action 'docker_build' executed successfully",
        timestamp: "2026-10-17T14:00:01.000Z",
        taskId: taskBuild.id,
        metadata: {
          actionName: "docker_build",
          input: { dockerfile: "Dockerfile.prod", tag: "app:v1.2.0" },
        },
      },
      {
        id: eventId("evt-102"),
        runId: runSuccess.id,
        type: "tool_invoked",
        severity: "info",
        message: "Action 'kubectl_apply' executed successfully",
        timestamp: "2026-10-17T14:00:03.000Z",
        taskId: taskDeploy.id,
        metadata: {
          actionName: "kubectl_apply",
          input: { manifest: "deploy.yaml", namespace: "production" },
        },
      },
    ];

    evidenceProvider.setRunEvidence(runSuccess, eventsSuccess);

    // 3. Define a 6-case EvaluationSuite spanning all 4 evaluators + failures + errors
    const suite: EvaluationSuite = {
      id: evaluationSuiteId("suite-regression-prod"),
      version: 1,
      name: "Production Deployment Verification Suite",
      description: "Comprehensive deterministic regression verification across output, schema, lifecycle, and tools",
      createdAt: "2026-10-17T14:00:00.000Z",
      cases: [
        // Case 1: ExactMatch regex check (Pass)
        {
          id: evaluationCaseId("case-regex-status"),
          name: "Verify Deployment Status Output",
          description: "Ensures summary contains deployment status SUCCESS",
          target: { type: "existing_run", runId: runSuccess.id },
          evaluatorId: evaluatorId("exact_match"),
          evaluatorConfig: {
            expectedPattern: '"status":\\s*"SUCCESS"',
            matchMode: "regex",
          },
        },
        // Case 2: JsonSchema conformance check (Pass)
        {
          id: evaluationCaseId("case-schema-conformance"),
          name: "Validate Structured Summary JSON Schema",
          description: "Enforces Draft-07 schema on deployment result summary",
          target: { type: "existing_run", runId: runSuccess.id },
          evaluatorId: evaluatorId("json_schema"),
          evaluatorConfig: {
            schema: {
              type: "object",
              required: ["status", "environment", "deploymentId", "replicas"],
              properties: {
                status: { type: "string", enum: ["SUCCESS", "FAILED"] },
                environment: { type: "string" },
                deploymentId: { type: "string" },
                replicas: { type: "integer", minimum: 1 },
              },
            },
            requiredKeys: ["status", "deploymentId"],
          },
        },
        // Case 3: ToolCall verification (Pass)
        {
          id: evaluationCaseId("case-tool-calls"),
          name: "Verify Required Infrastructure Tools Invocations",
          description: "Verifies docker_build and kubectl_apply tools were called with arguments",
          target: { type: "existing_run", runId: runSuccess.id },
          evaluatorId: evaluatorId("tool_call"),
          evaluatorConfig: {
            requiredTools: ["docker_build", "kubectl_apply"],
            forbiddenTools: ["helm_delete", "kubectl_delete"],
            expectedArguments: {
              docker_build: { tag: "app:v1.2.0" },
              kubectl_apply: { namespace: "production" },
            },
          },
        },
        // Case 4: RunLifecycle status and max duration check (Pass)
        {
          id: evaluationCaseId("case-lifecycle-duration"),
          name: "Verify Run Lifecycle SLA",
          description: "Verifies run completed within 10-second SLA limit",
          target: { type: "existing_run", runId: runSuccess.id },
          evaluatorId: evaluatorId("run_lifecycle"),
          evaluatorConfig: {
            expectedStatus: "completed",
            maxDurationMs: 10000,
          },
        },
        // Case 5: ExactMatch failure check (Fail with assertion_failed)
        {
          id: evaluationCaseId("case-failing-expectation"),
          name: "Negative Assertion Case",
          description: "Expects CANCELLED status which should fail",
          target: { type: "existing_run", runId: runSuccess.id },
          evaluatorId: evaluatorId("exact_match"),
          evaluatorConfig: {
            expectedPattern: '"status": "CANCELLED"',
            matchMode: "contains",
          },
        },
        // Case 6: Missing Evidence error check (Error with missing_evidence)
        {
          id: evaluationCaseId("case-missing-evidence"),
          name: "Missing Evidence Error Case",
          description: "Targets non-existent run ID to verify fault isolation",
          target: { type: "existing_run", runId: runId("run-ghost-999") },
          evaluatorId: evaluatorId("exact_match"),
          evaluatorConfig: {
            expectedPattern: "irrelevant",
          },
        },
      ],
    };

    // 4. Execute the suite using DeterministicEvaluationEngine
    const engine = new DeterministicEvaluationEngine(registry, evidenceProvider);
    const { run, results } = await engine.evaluateSuite({
      suite,
      captureRawOutput: true,
      triggeredBy: "ci-pipeline",
    });

    // 5. Verify EvaluationRun matches Phase 14A schema
    const parsedRun = evaluationRunSchema.safeParse(run);
    expect(parsedRun.success).toBe(true);

    expect(run.status).toBe("completed");
    expect(run.suiteId).toBe(suite.id);
    expect(run.suiteVersion).toBe(1);
    expect(run.triggeredBy).toBe("ci-pipeline");
    expect(run.startedAt).toBeDefined();
    expect(run.completedAt).toBeDefined();

    // 6. Verify EvaluationResult collection matches Phase 14A schema
    expect(results).toHaveLength(6);
    for (const res of results) {
      const parsedRes = evaluationResultSchema.safeParse(res);
      expect(parsedRes.success).toBe(true);
      expect(res.lifecycleStatus).toBe("completed");
    }

    // Inspect individual outcomes
    expect(results[0]?.outcome?.verdict).toBe("pass");
    expect(results[0]?.outcome?.score).toBe(1.0);

    expect(results[1]?.outcome?.verdict).toBe("pass");
    expect(results[1]?.outcome?.score).toBe(1.0);

    expect(results[2]?.outcome?.verdict).toBe("pass");
    expect(results[2]?.outcome?.score).toBe(1.0);

    expect(results[3]?.outcome?.verdict).toBe("pass");
    expect(results[3]?.outcome?.score).toBe(1.0);

    expect(results[4]?.outcome?.verdict).toBe("fail");
    expect(results[4]?.outcome?.score).toBe(0.0);
    expect(results[4]?.outcome?.failureClassification).toBe("assertion_failed");

    expect(results[5]?.outcome?.verdict).toBe("error");
    expect(results[5]?.outcome?.score).toBeNull();
    expect(results[5]?.outcome?.failureClassification).toBe("missing_evidence");

    // 7. Strictly verify the Phase 14A completion invariant:
    // passedCases + failedCases + errorCases + skippedCases === totalCases
    expect(isEvaluationRunComplete(run.metrics)).toBe(true);
    expect(run.metrics.totalCases).toBe(6);
    expect(run.metrics.passedCases).toBe(4);
    expect(run.metrics.failedCases).toBe(1);
    expect(run.metrics.errorCases).toBe(1);
    expect(run.metrics.skippedCases).toBe(0);

    // Pass rate: passed / (passed + failed) = 4 / 5 = 0.8
    expect(run.metrics.passRate).toBeCloseTo(0.8, 5);
    // Error rate: error / total = 1 / 6 = ~0.16667
    expect(run.metrics.errorRate).toBeCloseTo(1 / 6, 5);
    // Skipped rate: 0
    expect(run.metrics.skippedRate).toBe(0);
    // Mean score over [1, 1, 1, 1, 0] = 4 / 5 = 0.8
    expect(run.metrics.meanScore).toBeCloseTo(0.8, 5);
  });
});
