import type {
  AssertionResult,
  EvaluatorErrorContract,
  EvaluatorInput,
  EvaluatorKind,
  EvaluatorMetricType,
  EvaluatorOutput,
  IEvaluator,
} from "@aegis/contracts";
import { MAX_RAW_OUTPUT_BYTES } from "@aegis/contracts";
import type { EvaluatorId, Result } from "@aegis/types";
import { evaluatorId, ok } from "@aegis/types";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schema
// ─────────────────────────────────────────────────────────────────────────────

export const exactMatchConfigSchema = z.object({
  expectedPattern: z.string().min(1, "expectedPattern must not be empty"),
  matchMode: z.enum(["exact", "contains", "regex"]).default("contains"),
  caseSensitive: z.boolean().default(true),
});
export type ExactMatchConfig = z.infer<typeof exactMatchConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// ExactMatch Evaluator Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic evaluator verifying that an execution output matches an expected pattern.
 * Supports exact string equality, substring inclusion, and regular expressions.
 */
export class ExactMatchEvaluator implements IEvaluator {
  readonly id: EvaluatorId = evaluatorId("exact_match");
  readonly version = "1.0.0";
  readonly kind: EvaluatorKind = "deterministic";
  readonly metricType: EvaluatorMetricType = "binary";

  evaluate(
    input: EvaluatorInput,
  ): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>> {
    // 1. Validate configuration
    const parsedConfig = exactMatchConfigSchema.safeParse(input.config ?? {});
    if (!parsedConfig.success) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Invalid ExactMatch configuration: ${parsedConfig.error.message}`,
          assertions: [],
        }),
      );
    }
    const { expectedPattern, matchMode, caseSensitive } = parsedConfig.data;

    // 2. Resolve output from evidence (target task output or run output)
    let output: string | undefined;
    if (input.target.taskId) {
      const task = input.executionEvidence.run.tasks.find(
        (t) => t.id === input.target.taskId,
      );
      if (!task) {
        return Promise.resolve(
          ok({
            verdict: "error",
            score: null,
            failureClassification: "missing_evidence",
            reason: `Target taskId '${input.target.taskId}' not found in execution evidence`,
            assertions: [],
          }),
        );
      }
      output = task.output;
    } else {
      output = input.executionEvidence.run.result?.summary;
    }

    // 3. Strict evidence completeness check: output undefined indicates missing evidence
    if (output === undefined) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "missing_evidence",
          reason: "Execution evidence contains no output string to evaluate",
          assertions: [],
        }),
      );
    }

    // 4. Perform deterministic pattern matching
    let passed = false;
    let matchDetail = "";

    try {
      if (matchMode === "exact") {
        passed = caseSensitive
          ? output === expectedPattern
          : output.toLowerCase() === expectedPattern.toLowerCase();
        matchDetail = passed
          ? "Output matches expected pattern exactly"
          : `Output did not match exact expected string (expected: '${expectedPattern}')`;
      } else if (matchMode === "contains") {
        passed = caseSensitive
          ? output.includes(expectedPattern)
          : output.toLowerCase().includes(expectedPattern.toLowerCase());
        matchDetail = passed
          ? `Output contains expected substring '${expectedPattern}'`
          : `Output does not contain expected substring '${expectedPattern}'`;
      } else {
        const flags = caseSensitive ? "" : "i";
        const regex = new RegExp(expectedPattern, flags);
        passed = regex.test(output);
        matchDetail = passed
          ? `Output matches regular expression /${expectedPattern}/${flags}`
          : `Output does not match regular expression /${expectedPattern}/${flags}`;
      }
    } catch (regexError) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Malformed regular expression pattern: ${regexError instanceof Error ? regexError.message : String(regexError)}`,
          assertions: [],
        }),
      );
    }

    const assertions: AssertionResult[] = [
      {
        name: `Pattern match (${matchMode})`,
        passed,
        message: matchDetail,
      },
    ];

    const rawOutputSnippet =
      input.captureRawOutput && output.length > 0
        ? output.slice(0, MAX_RAW_OUTPUT_BYTES)
        : undefined;

    if (passed) {
      return Promise.resolve(
        ok({
          verdict: "pass",
          score: 1.0,
          reason: matchDetail,
          assertions,
          rawOutputSnippet,
        }),
      );
    }

    return Promise.resolve(
      ok({
        verdict: "fail",
        score: 0.0,
        failureClassification: "assertion_failed",
        reason: matchDetail,
        assertions,
        rawOutputSnippet,
      }),
    );
  }
}
