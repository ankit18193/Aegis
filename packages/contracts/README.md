# @aegis/contracts

**Canonical API contracts, validation schemas, and transport-agnostic interfaces for the Aegis platform.**

---

## Overview & Architectural Invariants

`@aegis/contracts` defines the single source of truth for domain entities, lifecycle states, API request/response envelopes, error contracts, and transport-agnostic client abstractions across the Aegis Distributed AI Agent Execution Platform.

### Core Invariants

1. **Single Source of Truth**: All domain and DTO types are derived directly from runtime Zod schemas via `z.infer`. No duplicate interfaces and validation schemas.
2. **Transport Agnostic**: Contracts are plain TypeScript schemas and DTOs. They contain zero dependencies on transport frameworks (no Express, Fastify, HTTP codes, or WebSocket libraries).
3. **Nominal Branded Typing**: Branded identifiers (`RunId`, `TaskId`, `WorkflowId`, `WorkerId`, `EventId`) from `@aegis/types` are strictly maintained and validated across contracts.
4. **Clean Boundary Separation**: Pure domain primitives and branded IDs live in `@aegis/types`; structural foundation utilities live in `@aegis/foundation`; canonical validation schemas and DTO contracts live in `@aegis/contracts`.
5. **Separation of Concerns**: High-frequency list endpoints use lightweight projections (`RunSummary`) to prevent heavy over-fetching of full task and result aggregates (`Run`).

---

## Contents & Modules

### 1. Domain Entities & Schemas (`src/runs.ts`)

| Schema | Inferred Type | Description |
| :--- | :--- | :--- |
| `runSchema` | `Run` | Complete aggregate execution run including workflow, tasks, and results. |
| `runSummarySchema` | `RunSummary` | Lightweight projection for high-volume list and query endpoints. |
| `taskSchema` | `Task` | Individual execution task within a workflow graph. |
| `workflowSchema` | `Workflow` | Directed execution workflow container for tasks. |
| `runResultSchema` | `RunResult` | Execution results, duration metrics, report markdown, and artifacts. |
| `runResultArtifactSchema` | `RunResultArtifact` | Output artifact metadata produced by an execution run. |
| `runStatusSchema` | `RunStatus` | Lifecycle status enum (`pending`, `running`, `completed`, `failed`, `cancelled`). |
| `taskStatusSchema` | `TaskStatus` | Task lifecycle enum (`pending`, `queued`, `running`, `completed`, `failed`, `retrying`, `cancelled`). |

#### Lifecycle State Machines & Transition Guards

`@aegis/contracts` enforces deterministic lifecycle state machines with zero outgoing transitions from terminal states:

```ts
import { isValidRunTransition, isValidTaskTransition } from "@aegis/contracts";

isValidRunTransition("pending", "running"); // true
isValidRunTransition("pending", "completed"); // false
isValidRunTransition("completed", "running"); // false (terminal state)

isValidTaskTransition("running", "retrying"); // true
isValidTaskTransition("retrying", "queued"); // true
isValidTaskTransition("completed", "running"); // false (terminal state)
```

---

### 2. Execution Audit Events (`src/events.ts`)

| Schema | Inferred Type | Description |
| :--- | :--- | :--- |
| `runEventSchema` | `RunEvent` | Immutable audit log event recorded during run or task execution. |
| `eventTypeSchema` | `EventType` | Event category (`run_created`, `workflow_started`, `task_started`, etc.). |
| `eventSeveritySchema` | `EventSeverity` | Severity classification (`info`, `warn`, `error`, `success`). |

---

### 3. API Request & Response Contracts (`src/api.ts`)

| Request Schema / Type | Response Schema / Type | Operation |
| :--- | :--- | :--- |
| `createRunRequestSchema` (`CreateRunRequest`) | `createRunResponseSchema` (`CreateRunResponse`) | Initiate a new execution run. |
| `getRunResponseSchema` (`GetRunResponse`) | Retrieve full details of an execution run by ID. |
| `listRunsQuerySchema` (`ListRunsQuery`) | `listRunsResponseSchema` (`ListRunsResponse`) | Paginated list of runs with status and text filtering. |
| `cancelRunRequestSchema` (`CancelRunRequest`) | `cancelRunResponseSchema` (`CancelRunResponse`) | Request abort/cancellation of an in-flight run. |
| `getRunEventsQuerySchema` (`GetRunEventsQuery`) | `getRunEventsResponseSchema` (`GetRunEventsResponse`) | Filtered timeline events for an execution run. |

---

### 4. Transport-Agnostic Error Envelopes (`src/errors.ts`)

Error responses are standardized without coupling to HTTP transport status codes:

```ts
import { createApiError, formatZodError } from "@aegis/contracts";

// Structured error creation
const notFound = createApiError("NOT_FOUND", "Run run-123 does not exist");

// Zod validation error formatting
const validationErr = formatZodError(zodError, "trace-abc-123");
```

Recognized error codes:
* `BAD_REQUEST`
* `UNAUTHORIZED`
* `FORBIDDEN`
* `VALIDATION_ERROR`
* `NOT_FOUND`
* `CONFLICT`
* `UNPROCESSABLE_ENTITY`
* `INTERNAL_SERVER_ERROR`
* `SERVICE_UNAVAILABLE`

---

### 5. Transport-Agnostic Client Contract (`src/client.ts`)

```ts
export interface IRunApiClient {
  listRuns(query?: ListRunsQuery): Promise<Result<ListRunsResponse, ApiErrorResponse>>;
  getRun(id: string): Promise<Result<GetRunResponse, ApiErrorResponse>>;
  createRun(request: CreateRunRequest): Promise<Result<CreateRunResponse, ApiErrorResponse>>;
  cancelRun(id: string, request?: CancelRunRequest): Promise<Result<CancelRunResponse, ApiErrorResponse>>;
  getRunEvents(runId: string, query?: GetRunEventsQuery): Promise<Result<GetRunEventsResponse, ApiErrorResponse>>;
}
```

This interface enables consumers (such as `apps/console`) to swap between the Phase 1 mock repository service and the future Phase 3 HTTP API without altering client-side code.

---

## Usage Example

```ts
import {
  createRunRequestSchema,
  runSchema,
  type CreateRunRequest,
  type Run,
} from "@aegis/contracts";

// Runtime validation
const validatedInput: CreateRunRequest = createRunRequestSchema.parse({
  goal: "Optimize database index distribution across cluster",
});

// Type derivation
const run: Run = runSchema.parse(rawServerPayload);
```
