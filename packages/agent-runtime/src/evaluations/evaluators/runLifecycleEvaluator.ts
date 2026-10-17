import type {
  AssertionResult,
  EvaluatorErrorContract,
  EvaluatorInput,
  EvaluatorKind,
  EvaluatorMetricType,
  EvaluatorOutput,
  IEvaluator,
} from "@aegis/contracts";
import type { EvaluatorId, Result } from "@aegis/types";
import { evaluatorId, ok } from "@aegis/types";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schema
// ─────────────────────────────────────────────────────────────────────────────

export const runLifecycleConfigSchema = z.object({
  expectedStatus: z
    .enum(["completed", "failed", "cancelled"])
    .default("completed"),
  maxDurationMs: z.number().int().positive().optional(),
  minDurationMs: z.number().int().nonnegative().optional(),
});
export type RunLifecycleConfig = z.infer<typeof runLifecycleConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// RunLifecycle Evaluator Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic evaluator verifying that an execution run reached an expected terminal status
 * and completed within acceptable duration boundaries.
 */
export class RunLifecycleEvaluator implements IEvaluator {
  readonly id: EvaluatorId = evaluatorId("run_lifecycle");
  readonly version = "1.0.0";
  readonly kind: EvaluatorKind = "deterministic";
  readonly metricType: EvaluatorMetricType = "binary";

  evaluate(
    input: EvaluatorInput,
  ): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>> {
    // 1. Validate configuration
    const parsedConfig = runLifecycleConfigSchema.safeParse(input.config ?? {});
    if (!parsedConfig.success) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Invalid RunLifecycle configuration: ${parsedConfig.error.message}`,
          assertions: [],
        }),
      );
    }
    const { expectedStatus, maxDurationMs, minDurationMs } = parsedConfig.data;
    const { run } = input.executionEvidence;

    const assertions: AssertionResult[] = [];

    // 2. Validate terminal status
    const statusMatches = run.status === expectedStatus;
    assertions.push({
      name: `Status equals '${expectedStatus}'`,
      passed: statusMatches,
      message: statusMatches
        ? `Run completed with expected status '${expectedStatus}'`
        : `Run status '${run.status}' does not match expected status '${expectedStatus}'`,
    });

    if (!statusMatches) {
      return Promise.resolve(
        ok({
          verdict: "fail",
          score: 0.0,
          failureClassification: "assertion_failed",
          reason: `Run status '${run.status}' does not match expected status '${expectedStatus}'`,
          assertions,
        }),
      );
    }

    // 3. Validate duration boundaries if configured
    if (maxDurationMs !== undefined || minDurationMs !== undefined) {
      let durationMs: number | undefined;

      // Primary source: run metrics duration
      if (
        run.result?.metrics?.durationMs !== undefined &&
        !Number.isNaN(run.result.metrics.durationMs)
      ) {
        durationMs = run.result.metrics.durationMs;
      } else {
        // Fallback source: delta between createdAt and updatedAt for terminal runs
        const createdTime = Date.parse(run.createdAt);
        const updatedTime = Date.parse(run.updatedAt);
        if (
          !Number.isNaN(createdTime) &&
          !Number.isNaN(updatedTime) &&
          updatedTime >= createdTime
        ) {
          durationMs = updatedTime - createdTime;
        }
      }

      // If duration could not be computed, report missing evidence
      if (durationMs === undefined) {
        return Promise.resolve(
          ok({
            verdict: "error",
            score: null,
            failureClassification: "missing_evidence",
            reason:
              "Run duration cannot be determined from evidence (missing metrics.durationMs and invalid timestamps)",
            assertions,
          }),
        );
      }

      // Check max duration boundary (timeout)
      if (maxDurationMs !== undefined) {
        const withinMax = durationMs <= maxDurationMs;
        assertions.push({
          name: `Duration <= ${String(maxDurationMs)}ms`,
          passed: withinMax,
          message: withinMax
            ? `Duration (${String(durationMs)}ms) within max limit of ${String(maxDurationMs)}ms`
            : `Duration (${String(durationMs)}ms) exceeded timeout limit of ${String(maxDurationMs)}ms`,
        });

        if (!withinMax) {
          return Promise.resolve(
            ok({
              verdict: "fail",
              score: 0.0,
              failureClassification: "timeout",
              reason: `Run execution timed out (${String(durationMs)}ms > ${String(maxDurationMs)}ms)`,
              assertions,
            }),
          );
        }
      }

      // Check min duration boundary
      if (minDurationMs !== undefined) {
        const aboveMin = durationMs >= minDurationMs;
        assertions.push({
          name: `Duration >= ${String(minDurationMs)}ms`,
          passed: aboveMin,
          message: aboveMin
            ? `Duration (${String(durationMs)}ms) meets minimum of ${String(minDurationMs)}ms`
            : `Duration (${String(durationMs)}ms) is below minimum of ${String(minDurationMs)}ms`,
        });

        if (!aboveMin) {
          return Promise.resolve(
            ok({
              verdict: "fail",
              score: 0.0,
              failureClassification: "assertion_failed",
              reason: `Run duration (${String(durationMs)}ms) was below expected minimum (${String(minDurationMs)}ms)`,
              assertions,
            }),
          );
        }
      }
    }

    return Promise.resolve(
      ok({
        verdict: "pass",
        score: 1.0,
        reason: `Run satisfied status '${expectedStatus}' and all timing criteria`,
        assertions,
      }),
    );
  }
}
