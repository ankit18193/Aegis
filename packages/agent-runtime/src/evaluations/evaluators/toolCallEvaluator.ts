import type {
  AssertionResult,
  EvaluatorErrorContract,
  EvaluatorInput,
  EvaluatorKind,
  EvaluatorMetricType,
  EvaluatorOutput,
  IEvaluator,
  RunEvent,
} from "@aegis/contracts";
import type { EvaluatorId, Result } from "@aegis/types";
import { evaluatorId, ok } from "@aegis/types";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schema
// ─────────────────────────────────────────────────────────────────────────────

export const toolCallConfigSchema = z.object({
  requiredTools: z.array(z.string()).default([]),
  forbiddenTools: z.array(z.string()).default([]),
  expectedArguments: z.record(z.record(z.unknown())).optional(),
});
export type ToolCallConfig = z.infer<typeof toolCallConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(recordA[key], recordB[key])) {
      return false;
    }
  }
  return true;
}

function resolveToolName(event: RunEvent): string | undefined {
  const metadata = event.metadata;
  if (
    typeof metadata?.["actionName"] === "string" &&
    metadata["actionName"].trim().length > 0
  ) {
    return metadata["actionName"];
  }
  if (
    typeof metadata?.["toolName"] === "string" &&
    metadata["toolName"].trim().length > 0
  ) {
    return metadata["toolName"];
  }
  const match = /Action '([^']+)'/.exec(event.message);
  if (match?.[1]) {
    return match[1];
  }
  return undefined;
}

interface ExtractedInvocation {
  readonly toolName: string;
  readonly args: Record<string, unknown> | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolCall Evaluator Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic evaluator verifying that required tools were invoked, forbidden
 * tools were not invoked, and tool call arguments match expectations in the event log.
 */
export class ToolCallEvaluator implements IEvaluator {
  readonly id: EvaluatorId = evaluatorId("tool_call");
  readonly version = "1.0.0";
  readonly kind: EvaluatorKind = "deterministic";
  readonly metricType: EvaluatorMetricType = "binary";

  evaluate(
    input: EvaluatorInput,
  ): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>> {
    // 1. Validate configuration
    const parsedConfig = toolCallConfigSchema.safeParse(input.config ?? {});
    if (!parsedConfig.success) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Invalid ToolCall configuration: ${parsedConfig.error.message}`,
          assertions: [],
        }),
      );
    }
    const { requiredTools, forbiddenTools, expectedArguments } = parsedConfig.data;

    // 2. Strict evidence completeness check: events undefined indicates missing evidence
    if (input.executionEvidence.events === undefined) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "missing_evidence",
          reason: "Execution evidence contains no event stream to evaluate",
          assertions: [],
        }),
      );
    }

    // 3. Extract tool invocations from events, optionally filtering by target taskId
    let candidateEvents = input.executionEvidence.events;
    if (input.target.taskId) {
      candidateEvents = candidateEvents.filter(
        (e) => e.taskId === input.target.taskId,
      );
    }

    const invocations: ExtractedInvocation[] = [];
    for (const event of candidateEvents) {
      if (event.type === "tool_invoked") {
        const toolName = resolveToolName(event);
        if (toolName) {
          const rawInput = event.metadata?.["input"];
          invocations.push({
            toolName,
            args:
              typeof rawInput === "object" && rawInput !== null
                ? (rawInput as Record<string, unknown>)
                : undefined,
          });
        }
      }
    }

    const assertions: AssertionResult[] = [];
    const invokedToolNames = new Set(invocations.map((i) => i.toolName));

    // 4. Assert required tools
    for (const tool of requiredTools) {
      const invoked = invokedToolNames.has(tool);
      assertions.push({
        name: `required_tool:${tool}`,
        passed: invoked,
        message: invoked
          ? `Required tool '${tool}' was invoked`
          : `Required tool '${tool}' was never invoked`,
      });
    }

    // 5. Assert forbidden tools
    for (const tool of forbiddenTools) {
      const invoked = invokedToolNames.has(tool);
      assertions.push({
        name: `forbidden_tool:${tool}`,
        passed: !invoked,
        message: !invoked
          ? `Forbidden tool '${tool}' was not invoked`
          : `Forbidden tool '${tool}' was invoked`,
      });
    }

    // 6. Assert expected arguments
    if (expectedArguments) {
      for (const [tool, expectedArgs] of Object.entries(expectedArguments)) {
        const matchingInvocations = invocations.filter((i) => i.toolName === tool);
        if (matchingInvocations.length === 0) {
          assertions.push({
            name: `tool_arguments:${tool}`,
            passed: false,
            message: `Tool '${tool}' was not invoked, unable to verify expected arguments`,
          });
          continue;
        }

        const anyMatched = matchingInvocations.some((inv) => {
          if (!inv.args) return false;
          for (const [key, expectedVal] of Object.entries(expectedArgs)) {
            if (!deepEqual(inv.args[key], expectedVal)) {
              return false;
            }
          }
          return true;
        });

        assertions.push({
          name: `tool_arguments:${tool}`,
          passed: anyMatched,
          message: anyMatched
            ? `Tool '${tool}' was invoked with matching expected arguments`
            : `Tool '${tool}' arguments did not match expected parameters`,
        });
      }
    }

    // 7. Aggregate outcome
    const allPassed = assertions.every((a) => a.passed);
    if (!allPassed) {
      const firstFailure = assertions.find((a) => !a.passed);
      return Promise.resolve(
        ok({
          verdict: "fail",
          score: 0.0,
          failureClassification: "assertion_failed",
          reason: firstFailure?.message ?? "One or more tool call assertions failed",
          assertions,
        }),
      );
    }

    return Promise.resolve(
      ok({
        verdict: "pass",
        score: 1.0,
        reason: "All tool call constraints and argument assertions satisfied",
        assertions,
      }),
    );
  }
}
