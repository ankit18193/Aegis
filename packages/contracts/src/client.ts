import type { Result } from "@aegis/types";

import type {
  CancelRunRequest,
  CancelRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  GetRunEventsQuery,
  GetRunEventsResponse,
  GetRunResponse,
  ListRunsQuery,
  ListRunsResponse,
} from "./api.js";
import type { ApiErrorResponse } from "./errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Transport-Agnostic Run API Client Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal transport-agnostic client contract for Run operations.
 *
 * This contract enables clean decoupling between the client caller (such as
 * apps/console) and the underlying transport (Phase 1 mock service vs Phase 3 HTTP API)
 * without leaking transport details or requiring speculative adapters.
 */
export interface IRunApiClient {
  /**
   * Retrieves a paginated list of runs, optionally filtered by status or search query.
   */
  listRuns(query?: ListRunsQuery): Promise<Result<ListRunsResponse, ApiErrorResponse>>;

  /**
   * Retrieves full details for a single execution run by its ID.
   */
  getRun(id: string): Promise<Result<GetRunResponse, ApiErrorResponse>>;

  /**
   * Submits a request to create and initiate a new execution run.
   */
  createRun(request: CreateRunRequest): Promise<Result<CreateRunResponse, ApiErrorResponse>>;

  /**
   * Requests cancellation of an in-flight execution run.
   */
  cancelRun(
    id: string,
    request?: CancelRunRequest,
  ): Promise<Result<CancelRunResponse, ApiErrorResponse>>;

  /**
   * Retrieves timeline events associated with an execution run.
   */
  getRunEvents(
    runId: string,
    query?: GetRunEventsQuery,
  ): Promise<Result<GetRunEventsResponse, ApiErrorResponse>>;
}
