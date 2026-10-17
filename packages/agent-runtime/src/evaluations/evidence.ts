import type { ExistingRunTarget, Run, RunEvent } from "@aegis/contracts";
import type { Result, RunId } from "@aegis/types";
import { err, ok } from "@aegis/types";

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Provider Contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidenceErrorContract {
  readonly code: string;
  readonly message: string;
}

export interface ResolvedExecutionEvidence {
  readonly run: Run;
  readonly events?: readonly RunEvent[] | undefined;
}

/**
 * Interface for resolving execution evidence (runs and audit events)
 * to be inspected by deterministic and model-based evaluators.
 */
export interface IEvidenceProvider {
  resolveEvidence(
    target: ExistingRunTarget,
  ): Promise<Result<ResolvedExecutionEvidence, EvidenceErrorContract>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Evidence Provider (Deterministic Testing Fixture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory implementation of IEvidenceProvider for hermetic unit and integration tests.
 */
export class InMemoryEvidenceProvider implements IEvidenceProvider {
  private readonly store = new Map<RunId, ResolvedExecutionEvidence>();

  /**
   * Sets or updates the mock evidence for a given Run.
   */
  setRunEvidence(run: Run, events?: readonly RunEvent[]): void {
    this.store.set(run.id, {
      run,
      ...(events !== undefined ? { events } : {}),
    });
  }

  /**
   * Clears all stored evidence.
   */
  clear(): void {
    this.store.clear();
  }

  resolveEvidence(
    target: ExistingRunTarget,
  ): Promise<Result<ResolvedExecutionEvidence, EvidenceErrorContract>> {
    const entry = this.store.get(target.runId);
    if (!entry) {
      return Promise.resolve(
        err({
          code: "RUN_NOT_FOUND",
          message: `Run '${target.runId}' not found in evidence provider`,
        }),
      );
    }
    return Promise.resolve(ok(entry));
  }
}
