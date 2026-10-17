import type { EvaluationRunId, EvaluationSuiteId, Result } from "@aegis/types";

import type { EvaluationRunStatus } from "./evaluationRun.js";

import type { EvaluationErrorResponse } from "./evaluationErrors.js";
import type { EvaluationResult } from "./evaluationResult.js";
import type { EvaluationRun, EvaluationRunSummary } from "./evaluationRun.js";
import type { EvaluationSuite } from "./evaluationSuite.js";

// ─────────────────────────────────────────────────────────────────────────────
// Request & Query Contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateEvaluationSuiteRequest {
  readonly name: string;
  readonly description?: string;
  readonly cases: readonly {
    readonly id?: string;
    readonly name: string;
    readonly description?: string;
    readonly target: {
      readonly type: "existing_run";
      readonly runId: string;
      readonly taskId?: string;
    };
    readonly evaluatorId: string;
    readonly evaluatorConfig?: Record<string, unknown>;
  }[];
}

export interface CreateEvaluationRunRequest {
  readonly suiteId: EvaluationSuiteId;
  readonly suiteVersion?: number; // Defaults to latest version if omitted
  readonly triggeredBy?: string;
}

export interface ListEvaluationRunsQuery {
  readonly suiteId?: EvaluationSuiteId;
  readonly status?: EvaluationRunStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport-Agnostic Evaluation API Client Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal transport-agnostic client contract for Evaluation operations.
 * Decouples apps/console and external consumers from Fastify/HTTP transport.
 */
export interface IEvaluationApiClient {
  /**
   * Retrieves an evaluation suite version snapshot.
   */
  getSuite(
    id: EvaluationSuiteId,
    version?: number,
  ): Promise<Result<EvaluationSuite, EvaluationErrorResponse>>;

  /**
   * Creates a new evaluation suite snapshot (or increments version if suite id exists).
   */
  createSuite(
    request: CreateEvaluationSuiteRequest,
  ): Promise<Result<EvaluationSuite, EvaluationErrorResponse>>;

  /**
   * Retrieves full details for an evaluation run by its ID.
   */
  getEvaluationRun(
    id: EvaluationRunId,
  ): Promise<Result<EvaluationRun, EvaluationErrorResponse>>;

  /**
   * Lists evaluation runs with optional filtering by suite or status.
   */
  listEvaluationRuns(
    query?: ListEvaluationRunsQuery,
  ): Promise<Result<readonly EvaluationRunSummary[], EvaluationErrorResponse>>;

  /**
   * Submits a request to create and initiate an evaluation run.
   */
  createEvaluationRun(
    request: CreateEvaluationRunRequest,
  ): Promise<Result<EvaluationRun, EvaluationErrorResponse>>;

  /**
   * Cancels an in-flight evaluation run.
   */
  cancelEvaluationRun(
    id: EvaluationRunId,
  ): Promise<Result<EvaluationRun, EvaluationErrorResponse>>;

  /**
   * Retrieves individual case evaluation results for an evaluation run.
   * Supports optional cursor-based pagination for large suites.
   */
  getEvaluationResults(
    runId: EvaluationRunId,
    query?: { limit?: number; cursor?: string },
  ): Promise<Result<readonly EvaluationResult[], EvaluationErrorResponse>>;
}
