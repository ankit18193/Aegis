import type { EvaluatorInput, Run } from "@aegis/contracts";
import { evaluationCaseId, runId, taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { JsonSchemaEvaluator } from "./jsonSchemaEvaluator.js";

function buildMockRun(params?: {
  summary?: string | undefined;
  tasks?: Run["tasks"] | undefined;
}): Run {
  return {
    id: runId("run-eval-schema-1"),
    goal: "Test JSON schema evaluation",
    status: "completed",
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:05.000Z",
    progress: 100,
    workflow: { id: "wf-1" as never, name: "Test Workflow", tasks: [] },
    tasks: params?.tasks ?? [],
    result:
      params?.summary !== undefined
        ? {
            summary: params.summary,
            metrics: {
              durationMs: 5000,
              tasksTotal: 1,
              tasksCompleted: 1,
              toolInvocations: 0,
            },
          }
        : undefined,
  };
}

describe("JsonSchemaEvaluator (Phase 14B — Milestone 3)", () => {
  const evaluator = new JsonSchemaEvaluator();

  it("passes when output conforms to JSON Schema and syntax constraints", async () => {
    const validJsonOutput = JSON.stringify({
      orderId: "ord-123",
      itemsCount: 4,
      status: "shipped",
    });

    const run = buildMockRun({ summary: validJsonOutput });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-1"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: {
          type: "object",
          required: ["orderId", "itemsCount", "status"],
          properties: {
            orderId: { type: "string" },
            itemsCount: { type: "integer", minimum: 1 },
            status: { type: "string", enum: ["pending", "shipped", "delivered"] },
          },
        },
      },
      captureRawOutput: true,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("pass");
    expect(result.value.score).toBe(1.0);
    expect(result.value.failureClassification).toBeUndefined();
    expect(result.value.rawOutputSnippet).toBe(validJsonOutput);
    expect(result.value.assertions.length).toBe(2);
    expect(result.value.assertions[0]?.passed).toBe(true);
    expect(result.value.assertions[1]?.passed).toBe(true);
  });

  it("fails with schema_violation when output is not valid JSON", async () => {
    const malformedOutput = "{ orderId: 'not-json',, }";
    const run = buildMockRun({ summary: malformedOutput });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-2"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: { type: "object" },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("schema_violation");
    expect(result.value.assertions[0]?.name).toBe("json_syntax");
    expect(result.value.assertions[0]?.passed).toBe(false);
  });

  it("fails with schema_violation when required property is missing", async () => {
    const jsonOutput = JSON.stringify({
      orderId: "ord-123",
    });

    const run = buildMockRun({ summary: jsonOutput });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-3"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: {
          type: "object",
          required: ["orderId", "amount"],
          properties: {
            orderId: { type: "string" },
            amount: { type: "number" },
          },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("schema_violation");
    expect(result.value.reason).toContain("Required property 'amount' is missing");
  });

  it("fails with schema_violation when property type does not match", async () => {
    const jsonOutput = JSON.stringify({
      count: "four",
    });

    const run = buildMockRun({ summary: jsonOutput });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-4"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: {
          type: "object",
          properties: {
            count: { type: "integer" },
          },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("schema_violation");
    expect(result.value.reason).toContain("Expected type integer");
  });

  it("returns missing_evidence when output is undefined", async () => {
    const run = buildMockRun({ summary: undefined });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-5"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: { type: "object" },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("missing_evidence");
  });

  it("enforces maxOutputBytes resource boundary", async () => {
    const hugeOutput = JSON.stringify({ data: "a".repeat(200) });
    const run = buildMockRun({ summary: hugeOutput });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-6"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: { type: "object" },
        maxOutputBytes: 50,
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("schema_violation");
    expect(result.value.reason).toContain("Output byte length");
    expect(result.value.assertions[0]?.name).toBe("output_size_limit");
  });

  it("returns evaluator_error when schema depth exceeds maximum limit of 10", async () => {
    let deepSchema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 12; i++) {
      deepSchema = {
        type: "object",
        properties: {
          nested: deepSchema,
        },
      };
    }

    let deepData: unknown = "leaf";
    for (let i = 0; i < 12; i++) {
      deepData = { nested: deepData };
    }

    const run = buildMockRun({ summary: JSON.stringify(deepData) });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-7"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: deepSchema,
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("evaluator_error");
    expect(result.value.reason).toContain("Schema nesting depth exceeded maximum");
  });

  it("returns evaluator_error when schema regex pattern is malformed", async () => {
    const run = buildMockRun({ summary: JSON.stringify({ text: "hello" }) });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-8"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: {
          type: "object",
          properties: {
            text: { type: "string", pattern: "[unclosed-class" },
          },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("evaluator_error");
    expect(result.value.reason).toContain("Invalid regex pattern");
  });

  it("targets specific task output when target.taskId is provided", async () => {
    const taskA = {
      id: taskId("task-schema-a"),
      name: "Task A",
      status: "completed" as const,
      description: "",
      version: 1,
      attemptCount: 1,
      output: JSON.stringify({ key: "expected-value" }),
    };

    const run = buildMockRun({ summary: "global summary not json", tasks: [taskA] });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-9"),
      target: { type: "existing_run", runId: run.id, taskId: taskA.id },
      executionEvidence: { run },
      config: {
        schema: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("pass");
    expect(result.value.score).toBe(1.0);
  });

  it("validates top-level requiredKeys constraint", async () => {
    const run = buildMockRun({ summary: JSON.stringify({ name: "Aegis" }) });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-10"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: { type: "object" },
        requiredKeys: ["name", "version"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.failureClassification).toBe("schema_violation");
    expect(result.value.reason).toContain("Missing required top-level key(s): version");
  });

  it("returns evaluator_error on invalid configuration", async () => {
    const run = buildMockRun({ summary: JSON.stringify({}) });
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-schema-11"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run },
      config: {
        schema: "not-an-object",
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("evaluator_error");
  });
});
