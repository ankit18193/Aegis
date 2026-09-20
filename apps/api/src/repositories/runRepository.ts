import type {
  EventSeverity,
  EventType,
  Run,
  RunEvent,
  RunStatus,
  RunSummary,
} from "@aegis/contracts";
import type { RunId } from "@aegis/types";

export interface RunFilterOptions {
  status?: RunStatus | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  query?: string | undefined;
}

export interface EventFilterOptions {
  severity?: EventSeverity | undefined;
  type?: EventType | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface FindAllRunsResult {
  items: RunSummary[];
  totalCount: number;
  hasMore?: boolean;
}

export interface IRunRepository {
  findById(id: RunId): Promise<Run | null>;
  findAll(options?: RunFilterOptions): Promise<FindAllRunsResult>;
  /**
   * Persists a run and its tasks.
   * If events are provided, persists the run, tasks, and events within a single atomic boundary.
   */
  save(run: Run, events?: readonly RunEvent[]): Promise<void>;
  findEvents(runId: RunId, options?: EventFilterOptions): Promise<RunEvent[]>;
  saveEvent(event: RunEvent): Promise<void>;
  resetToDefaults(): Promise<void>;
}
