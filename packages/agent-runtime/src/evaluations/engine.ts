import { randomUUID } from "node:crypto";

import type {
  EvaluationCaseDefinition,
  EvaluationResult,
  EvaluationRun,
  EvaluationSuite,
} from "@aegis/contracts";
import {
  calculateEvaluationMetrics,
  evaluatorOutputSchema,
} from "@aegis/contracts";
import type { EvaluationRunId, EvaluationSuiteId } from "@aegis/types";
import { evaluationResultId, evaluationRunId } from "@aegis/types";

import type { IEvidenceProvider } from "./evidence.js";
import type { IEvaluatorRegistry } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Parameter Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluateCaseParams {
  readonly caseDef: EvaluationCaseDefinition;
  readonly suiteId: EvaluationSuiteId;
  readonly suiteVersion: number;
  readonly evaluationRunId: EvaluationRunId;
  readonly captureRawOutput?: boolean | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface EvaluateSuiteParams {
  readonly suite: EvaluationSuite;
  readonly runId?: EvaluationRunId | undefined;
  readonly triggeredBy?: string | undefined;
  readonly captureRawOutput?: boolean | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface EvaluationSuiteExecutionOutput {
  readonly run: EvaluationRun;
  readonly results: EvaluationResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Evaluation Engine Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-process evaluation engine that executes evaluation criteria against agent
 * execution evidence and produces reproducible, explainable results.
 */
export class DeterministicEvaluationEngine {
  constructor(
    private readonly registry: IEvaluatorRegistry,
    private readonly evidenceProvider: IEvidenceProvider,
  ) {}

  /**
   * Evaluates an individual evaluation case within an isolated execution boundary.
   */
  async evaluateCase(params: EvaluateCaseParams): Promise<EvaluationResult> {
    const { caseDef, suiteId, suiteVersion, evaluationRunId: runId, captureRawOutput, abortSignal } =
      params;

    const evaluatedAt = new Date().toISOString();

    // 1. Observe cancellation before commencing execution
    if (abortSignal?.aborted) {
      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: "unknown",
        lifecycleStatus: "completed",
        outcome: {
          verdict: "skipped",
          score: null,
          reason: "Evaluation run was cancelled before case execution commenced",
          evidence: {
            inspectedRunId: caseDef.target.runId,
            assertions: [],
          },
          evaluatedAt,
          durationMs: 0,
        },
      };
    }

    // 2. Resolve evaluator with version pinning
    const pinnedVersion =
      typeof caseDef.evaluatorConfig?.["evaluatorVersion"] === "string"
        ? caseDef.evaluatorConfig["evaluatorVersion"]
        : undefined;

    const evaluator = this.registry.resolve(caseDef.evaluatorId, pinnedVersion);
    if (!evaluator) {
      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: pinnedVersion ?? "unresolved",
        lifecycleStatus: "completed",
        outcome: {
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Evaluator '${caseDef.evaluatorId}' (version: ${pinnedVersion ?? "latest"}) is not registered`,
          evidence: {
            inspectedRunId: caseDef.target.runId,
            assertions: [],
          },
          evaluatedAt,
          durationMs: 0,
        },
      };
    }

    const resolvedVersion = evaluator.version;
    const startTime = Date.now();

    // 3. Resolve execution evidence
    const evidenceRes = await this.evidenceProvider.resolveEvidence(caseDef.target);
    if (!evidenceRes.ok) {
      const durationMs = Math.max(0, Date.now() - startTime);
      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: resolvedVersion,
        lifecycleStatus: "completed",
        outcome: {
          verdict: "error",
          score: null,
          failureClassification: "missing_evidence",
          reason: evidenceRes.error.message,
          evidence: {
            inspectedRunId: caseDef.target.runId,
            assertions: [],
          },
          evaluatedAt,
          durationMs,
        },
      };
    }

    // 4. Check cancellation post-evidence resolution
    if (abortSignal?.aborted) {
      const durationMs = Math.max(0, Date.now() - startTime);
      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: resolvedVersion,
        lifecycleStatus: "completed",
        outcome: {
          verdict: "skipped",
          score: null,
          reason: "Evaluation aborted mid-flight",
          evidence: {
            inspectedRunId: caseDef.target.runId,
            assertions: [],
          },
          evaluatedAt,
          durationMs,
        },
      };
    }

    // 5. Merge caseDef.expectedOutcome into configuration if defined
    const mergedConfig: Record<string, unknown> = {
      ...(caseDef.evaluatorConfig ?? {}),
    };
    if (caseDef.expectedOutcome) {
      if (
        caseDef.expectedOutcome.outputPattern !== undefined &&
        mergedConfig["expectedPattern"] === undefined
      ) {
        mergedConfig["expectedPattern"] = caseDef.expectedOutcome.outputPattern;
      }
      if (
        caseDef.expectedOutcome.requiredTools !== undefined &&
        mergedConfig["requiredTools"] === undefined
      ) {
        mergedConfig["requiredTools"] = caseDef.expectedOutcome.requiredTools;
      }
      if (
        caseDef.expectedOutcome.maxDurationMs !== undefined &&
        mergedConfig["maxDurationMs"] === undefined
      ) {
        mergedConfig["maxDurationMs"] = caseDef.expectedOutcome.maxDurationMs;
      }
    }

    // 6. Invoke evaluator under strict boundary isolation
    try {
      const evalRes = await evaluator.evaluate({
        caseId: caseDef.id,
        target: caseDef.target,
        executionEvidence: {
          run: evidenceRes.value.run,
          ...(evidenceRes.value.events !== undefined
            ? { events: [...evidenceRes.value.events] }
            : {}),
        },
        config: mergedConfig,
        captureRawOutput: captureRawOutput ?? false,
      });

      const durationMs = Math.max(0, Date.now() - startTime);

      if (abortSignal?.aborted) {
        return {
          id: evaluationResultId(`res-${randomUUID()}`),
          evaluationRunId: runId,
          caseId: caseDef.id,
          suiteId,
          suiteVersion,
          evaluatorId: caseDef.evaluatorId,
          evaluatorVersion: resolvedVersion,
          lifecycleStatus: "completed",
          outcome: {
            verdict: "skipped",
            score: null,
            reason: "Evaluation aborted mid-flight",
            evidence: {
              inspectedRunId: caseDef.target.runId,
              assertions: [],
            },
            evaluatedAt,
            durationMs,
          },
        };
      }

      if (!evalRes.ok) {
        return {
          id: evaluationResultId(`res-${randomUUID()}`),
          evaluationRunId: runId,
          caseId: caseDef.id,
          suiteId,
          suiteVersion,
          evaluatorId: caseDef.evaluatorId,
          evaluatorVersion: resolvedVersion,
          lifecycleStatus: "completed",
          outcome: {
            verdict: "error",
            score: null,
            failureClassification: "evaluator_error",
            reason: evalRes.error.message,
            evidence: {
              inspectedRunId: caseDef.target.runId,
              assertions: [],
            },
            evaluatedAt,
            durationMs,
          },
        };
      }

      // Validate output conforming to Phase 14A schema
      const parsedOutput = evaluatorOutputSchema.safeParse(evalRes.value);
      if (!parsedOutput.success) {
        return {
          id: evaluationResultId(`res-${randomUUID()}`),
          evaluationRunId: runId,
          caseId: caseDef.id,
          suiteId,
          suiteVersion,
          evaluatorId: caseDef.evaluatorId,
          evaluatorVersion: resolvedVersion,
          lifecycleStatus: "completed",
          outcome: {
            verdict: "error",
            score: null,
            failureClassification: "evaluator_error",
            reason: `Evaluator returned invalid output schema: ${parsedOutput.error.message}`,
            evidence: {
              inspectedRunId: caseDef.target.runId,
              assertions: [],
            },
            evaluatedAt,
            durationMs,
          },
        };
      }

      const out = parsedOutput.data;
      const inspectedEventIds = evidenceRes.value.events?.map((e) => e.id);

      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: resolvedVersion,
        lifecycleStatus: "completed",
        outcome: {
          verdict: out.verdict,
          score: out.score,
          ...(out.failureClassification
            ? { failureClassification: out.failureClassification }
            : {}),
          reason: out.reason,
          evidence: {
            inspectedRunId: caseDef.target.runId,
            ...(inspectedEventIds && inspectedEventIds.length > 0
              ? { inspectedEventIds }
              : {}),
            assertions: out.assertions,
            ...(out.rawOutputSnippet !== undefined
              ? { rawOutputSnippet: out.rawOutputSnippet }
              : {}),
          },
          evaluatedAt,
          durationMs,
        },
      };
    } catch (uncaughtError) {
      const durationMs = Math.max(0, Date.now() - startTime);
      return {
        id: evaluationResultId(`res-${randomUUID()}`),
        evaluationRunId: runId,
        caseId: caseDef.id,
        suiteId,
        suiteVersion,
        evaluatorId: caseDef.evaluatorId,
        evaluatorVersion: resolvedVersion,
        lifecycleStatus: "completed",
        outcome: {
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Uncaught evaluator exception: ${uncaughtError instanceof Error ? uncaughtError.message : String(uncaughtError)}`,
          evidence: {
            inspectedRunId: caseDef.target.runId,
            assertions: [],
          },
          evaluatedAt,
          durationMs,
        },
      };
    }
  }

  /**
   * Sequentially evaluates all cases within an EvaluationSuite.
   * Enforces fault isolation, strict cancellation transitions, and invariant verification.
   */
  async evaluateSuite(params: EvaluateSuiteParams): Promise<EvaluationSuiteExecutionOutput> {
    const { suite, captureRawOutput, abortSignal, triggeredBy } = params;
    const runId = params.runId ?? evaluationRunId(`eval-run-${randomUUID()}`);
    const createdAt = new Date().toISOString();
    const startedAt = createdAt;
    const startTime = Date.now();

    const results: EvaluationResult[] = [];
    let wasCancelled = false;

    // Sequential evaluation of all suite cases
    for (const caseDef of suite.cases) {
      if (abortSignal?.aborted) {
        wasCancelled = true;
        // All remaining cases are marked skipped with 0 duration
        results.push({
          id: evaluationResultId(`res-${randomUUID()}`),
          evaluationRunId: runId,
          caseId: caseDef.id,
          suiteId: suite.id,
          suiteVersion: suite.version,
          evaluatorId: caseDef.evaluatorId,
          evaluatorVersion: "unknown",
          lifecycleStatus: "completed",
          outcome: {
            verdict: "skipped",
            score: null,
            reason: "Evaluation run was cancelled before case execution commenced",
            evidence: {
              inspectedRunId: caseDef.target.runId,
              assertions: [],
            },
            evaluatedAt: new Date().toISOString(),
            durationMs: 0,
          },
        });
      } else {
        const caseResult = await this.evaluateCase({
          caseDef,
          suiteId: suite.id,
          suiteVersion: suite.version,
          evaluationRunId: runId,
          captureRawOutput,
          abortSignal,
        });

        if (caseResult.outcome?.verdict === "skipped" && abortSignal?.aborted) {
          wasCancelled = true;
        }
        results.push(caseResult);
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startTime);

    // Aggregate counters
    let passedCases = 0;
    let failedCases = 0;
    let errorCases = 0;
    let skippedCases = 0;
    const scores: (number | null)[] = [];

    for (const r of results) {
      if (!r.outcome) continue;
      switch (r.outcome.verdict) {
        case "pass":
          passedCases++;
          scores.push(r.outcome.score);
          break;
        case "fail":
          failedCases++;
          scores.push(r.outcome.score);
          break;
        case "error":
          errorCases++;
          break;
        case "skipped":
          skippedCases++;
          break;
      }
    }

    const metrics = calculateEvaluationMetrics({
      totalCases: suite.cases.length,
      passedCases,
      failedCases,
      errorCases,
      skippedCases,
      scores,
      durationMs,
    });

    const isCancelledRun = wasCancelled || (abortSignal?.aborted ?? false);
    const run: EvaluationRun = {
      id: runId,
      suiteId: suite.id,
      suiteVersion: suite.version,
      status: isCancelledRun ? "cancelled" : "completed",
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
      metrics,
      createdAt,
      startedAt,
      completedAt,
      ...(isCancelledRun ? { failureReason: "Evaluation cancelled by operator" } : {}),
    };

    return { run, results };
  }
}
