# Aegis Architecture: AI Evaluation Domain & Contracts (Phase 14A)

## 1. Overview & System Purpose

Phase 14 introduces the **AI Evaluation & Reliability** subsystem to the Aegis platform. Its mission is to enable objective, reproducible, and automated evaluation of agent executions.

Phase 14A establishes the **canonical domain model, branded types, Zod schemas, lifecycle state machines, evaluator interfaces, and aggregation invariants**. It enforces strict separation between execution and evaluation, deterministic metric calculations, and immutable versioned suite definitions.

---

## 2. Core Architectural Invariants

### 2.1 Execution vs. Evaluation Orthogonality
An Agent Execution Run (`RunId`) and an Evaluation Run (`EvaluationRunId`) are strictly distinct domain entities.
- An agent execution may complete with `status: "completed"`, while its evaluation outcome results in `verdict: "fail"` (e.g. if the agent hallucinated or failed constraint assertions).
- Conversely, in negative testing or adversarial test cases, an agent execution failing may be the expected outcome.
- Evaluation status never mutates or overrides the underlying agent execution state.

### 2.2 Immutable Suite Snapshots
- An `EvaluationSuite` represents an immutable versioned snapshot identified by `(id, version)`.
- Version snapshots have no `updatedAt` timestamp; they are created once and never modified in place.
- Modifying a suite (adding/removing cases, tuning thresholds) creates version $N+1$.
- An `EvaluationRun` binds immutably to `(suiteId, suiteVersion)`, guaranteeing that historical benchmarks remain permanently reproducible.

### 2.3 Post-Hoc Target Scoping
Phase 14A scopes evaluation targets strictly to completed execution records (`ExistingRunTarget`):
```typescript
{
  type: "existing_run",
  runId: RunId,
  taskId?: TaskId
}
```
Generative scenario evaluation (where an evaluation run prompts an agent to create new executions) is deferred to Phase 14D.

### 2.4 Terminal Completion Invariant
An `EvaluationRun` transitions to `completed` if and only if all cases terminate across the four mutually exclusive outcome counters:
$$\text{passedCases} + \text{failedCases} + \text{errorCases} + \text{skippedCases} = \text{totalCases}$$
Individual case failures or evaluator errors never fail the evaluation run; the run finishes processing all cases and records the exact outcome counts.

### 2.5 Null-Safe Pass Rate & Metric Semantics
- Evaluated cases with a definitive quality outcome are defined as:
  $$\text{evaluableCases} = \text{passedCases} + \text{failedCases}$$
- Pass rate is strictly defined as:
  $$\text{passRate} = \begin{cases} \dfrac{\text{passedCases}}{\text{evaluableCases}} & \text{if } \text{evaluableCases} > 0 \\ \text{null} & \text{if } \text{evaluableCases} = 0 \end{cases}$$
- When all cases encounter errors or are skipped ($\text{evaluableCases} = 0$), `passRate` is `null` (avoiding false 0% or 100% metrics).
- $\text{errorRate} = \text{errorCases} / \text{totalCases}$.
- $\text{skippedRate} = \text{skippedCases} / \text{totalCases}$.
- $\text{meanScore}$ is computed strictly over cases producing valid numeric scores.

---

## 3. Domain Model & Lifecycle State Machines

### 3.1 Entity Model
```
┌───────────────────────────┐
│      EvaluationSuite      │  (Immutable Snapshot: id, version)
└─────────────┬─────────────┘
              │ 1..* embeds
              ▼
┌───────────────────────────┐
│ EvaluationCaseDefinition  │  (target: { type: "existing_run", runId })
└─────────────┬─────────────┘
              │ evaluated during
              ▼
┌───────────────────────────┐    ┌───────────────────────────┐
│       EvaluationRun       │1  *│     EvaluationResult      │
├───────────────────────────┼────┼───────────────────────────┤
│ id: EvaluationRunId       │    │ id: EvaluationResultId    │
│ suiteId: EvaluationSuiteId│    │ lifecycleStatus: Lifecycle│──► pending | running | completed
│ suiteVersion: number      │    │ outcome?: EvalOutcome     │──► verdict: pass|fail|error|skipped
│ status: EvalRunStatus     │    └─────────────┬─────────────┘
│ metrics: EvaluationMetrics│                  │ evaluated by
└───────────────────────────┘                  ▼
                                 ┌───────────────────────────┐
                                 │         Evaluator         │  (IEvaluator: id, version, metricType)
                                 └───────────────────────────┘
```

### 3.2 Evaluation Run State Machine
```
             ┌───────────┐
             │  pending  │
             └─────┬─────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
   ┌───────────┐       ┌───────────┐
   │  running  │       │ cancelled │ [Terminal]
   └─────┬─────┘       └───────────┘
         │
   ┌─────┴───────────────┐
   ▼                     ▼
┌───────────┐      ┌───────────┐
│ completed │      │  failed   │ [Terminal]
└───────────┘      └───────────┘
 [Terminal]
```
- `pending -> running | cancelled`
- `running -> completed | failed | cancelled`
- `completed`, `failed`, `cancelled` are monotonically terminal with zero outgoing transitions.

### 3.3 Evaluation Result State Machine
```
┌───────────┐
│  pending  │  (outcome: undefined)
└─────┬─────┘
      ▼
┌───────────┐
│  running  │  (outcome: undefined)
└─────┬─────┘
      ▼
┌───────────┐
│ completed │  (outcome: EvaluationOutcome REQUIRED)
└───────────┘  [verdict: pass | fail | error | skipped]
```
- Separates lifecycle status from terminal outcome.
- When `lifecycleStatus` is `running`, `outcome` is forbidden.
- When `lifecycleStatus` is `completed`, `outcome` is mandatory.

---

## 4. Evaluator Contracts & Comparability

### 4.1 Evaluator Interface (`IEvaluator`)
Stateless, transport-agnostic interface:
```typescript
export interface IEvaluator {
  readonly id: EvaluatorId;
  readonly version: string; // Semantic version, e.g. "1.0.0"
  readonly kind: EvaluatorKind; // "deterministic" | "model_based"
  readonly metricType: EvaluatorMetricType; // "binary" | "continuous_score" | "categorical"
  evaluate(input: EvaluatorInput): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>>;
}
```

### 4.2 Comparability Invariant
Two evaluation runs or case results are comparable for regression analysis if and only if:
1. `suiteId` and `suiteVersion` match.
2. `evaluatorId` and `evaluatorVersion` match.
3. `metricType` matches.
Comparing heterogeneous evaluators without matching versions or metric types is mathematically invalid and rejected with `EVALUATOR_VERSION_MISMATCH`.

---

## 5. Failure Classification Taxonomy
Phase 14A restricts failure classifications to verifiable, deterministic failure types:
- `assertion_failed`: Explicit condition or test rule failed.
- `schema_violation`: Output failed JSON or structural schema validation.
- `timeout`: Execution exceeded configured duration threshold.
- `missing_evidence`: Target run has no output, tasks, or event timeline.
- `evaluator_error`: Evaluator threw an unhandled runtime error.
- `unclassified`: Fallback category.

Cognitive and subjective categories (e.g. `hallucination`, `prompt_injection`, `policy_violation`) are deferred to Phase 15.

---

## 6. Client Interface (`IEvaluationApiClient`)
Defined in `@aegis/contracts` using clean relative internal imports:
- `getSuite(id, version?)`
- `createSuite(request)`
- `getEvaluationRun(id)`
- `listEvaluationRuns(query?)`
- `createEvaluationRun(request)`
- `cancelEvaluationRun(id)`
- `getEvaluationResults(runId)`

---

## 7. Package Verification & Export Map
- `@aegis/types`:
  - `EvaluationSuiteId`, `evaluationSuiteId()`
  - `EvaluationCaseId`, `evaluationCaseId()`
  - `EvaluationRunId`, `evaluationRunId()`
  - `EvaluationResultId`, `evaluationResultId()`
  - `EvaluatorId`, `evaluatorId()`
- `@aegis/contracts`:
  - Re-exports all evaluation contracts and schemas from `@aegis/contracts/evaluations` and root index.
