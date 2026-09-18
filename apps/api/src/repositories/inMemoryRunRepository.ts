import type { Run, RunEvent, RunSummary } from "@aegis/contracts";
import type { RunId } from "@aegis/types";

import type { EventFilterOptions, IRunRepository, RunFilterOptions } from "./runRepository.js";
import { getInitialSeedEvents, getInitialSeedRuns } from "./seeds.js";

export class InMemoryRunRepository implements IRunRepository {
  private readonly runs = new Map<RunId, Run>();
  private readonly events = new Map<RunId, RunEvent[]>();

  constructor(seed = true) {
    if (seed) {
      this.populateSeeds();
    }
  }

  private populateSeeds(): void {
    this.runs.clear();
    this.events.clear();

    const seedRuns = getInitialSeedRuns();
    for (const run of seedRuns) {
      this.runs.set(run.id, structuredClone(run));
    }

    const seedEvents = getInitialSeedEvents();
    for (const [runIdKey, eventList] of Object.entries(seedEvents)) {
      this.events.set(runIdKey as RunId, structuredClone(eventList));
    }
  }

  findById(id: RunId): Promise<Run | null> {
    const run = this.runs.get(id);
    return Promise.resolve(run ? structuredClone(run) : null);
  }

  findAll(options?: RunFilterOptions): Promise<{ items: RunSummary[]; totalCount: number }> {
    let list = Array.from(this.runs.values());

    if (options?.status) {
      list = list.filter((r) => r.status === options.status);
    }

    if (options?.query && options.query.trim().length > 0) {
      const q = options.query.trim().toLowerCase();
      list = list.filter((r) => r.goal.toLowerCase().includes(q));
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalCount = list.length;

    // Apply cursor pagination if cursor is provided
    if (options?.cursor) {
      const cursorIndex = list.findIndex((r) => r.id === options.cursor);
      if (cursorIndex !== -1) {
        list = list.slice(cursorIndex + 1);
      }
    }

    const limit = options?.limit ?? 20;
    const paginated = list.slice(0, limit);

    const items: RunSummary[] = paginated.map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      progress: r.progress,
      totalTasks: r.tasks.length,
      completedTasks: r.tasks.filter((t) => t.status === "completed").length,
    }));

    return Promise.resolve({
      items: structuredClone(items),
      totalCount,
    });
  }

  save(run: Run): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
    return Promise.resolve();
  }

  findEvents(runId: RunId, options?: EventFilterOptions): Promise<RunEvent[]> {
    const list = this.events.get(runId) ?? [];
    let filtered = [...list];

    if (options?.severity) {
      filtered = filtered.filter((e) => e.severity === options.severity);
    }

    if (options?.type) {
      filtered = filtered.filter((e) => e.type === options.type);
    }

    // Sort chronologically ascending
    filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (options?.cursor) {
      const cursorIndex = filtered.findIndex((e) => e.id === options.cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const limit = options?.limit ?? 50;
    const paginated = filtered.slice(0, limit);

    return Promise.resolve(structuredClone(paginated));
  }

  saveEvent(event: RunEvent): Promise<void> {
    const existing = this.events.get(event.runId) ?? [];
    existing.push(structuredClone(event));
    this.events.set(event.runId, existing);
    return Promise.resolve();
  }

  resetToDefaults(): Promise<void> {
    this.populateSeeds();
    return Promise.resolve();
  }
}
