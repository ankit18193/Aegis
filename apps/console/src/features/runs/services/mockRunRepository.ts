import { SEED_RUNS } from "../../../mocks/seedRuns";
import type { CreateRunInput } from "../schemas/runSchemas";
import type { Run, RunListItem } from "../types";

const STORAGE_KEY = "aegis_console_runs_v1";

export class MockRunRepository {
  private runs = new Map<string, Run>();
  private subscribers = new Set<() => void>();
  private initialized = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (this.initialized) return;

    let loadedRuns: Run[] | null = null;

    try {
      if (typeof window !== "undefined") {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as unknown;
          if (Array.isArray(parsed) && parsed.length > 0) {
            loadedRuns = parsed as Run[];
          }
        }
      }
    } catch {
      // In case of parsing error or disabled storage, fallback cleanly to seed data
      loadedRuns = null;
    }

    const initial = loadedRuns ?? SEED_RUNS;
    this.runs.clear();
    for (const run of initial) {
      this.runs.set(run.id, { ...run });
    }

    this.initialized = true;
  }

  private persist(): void {
    try {
      if (typeof window !== "undefined") {
        const array = Array.from(this.runs.values());
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(array));
      }
    } catch {
      // Non-blocking in-memory persistence fallback
    }
  }

  private notify(): void {
    this.persist();
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch {
        // Ignore subscriber execution errors
      }
    }
  }

  public subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  public async getAllRuns(): Promise<RunListItem[]> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 15); });

    const items: RunListItem[] = Array.from(this.runs.values()).map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      progress: r.progress,
      totalTasks: r.tasks.length,
      completedTasks: r.tasks.filter((t) => t.status === "completed").length,
    }));

    // Sort newest first
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public async getRunById(id: string): Promise<Run | null> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 15); });

    const run = this.runs.get(id);
    if (!run) return null;
    return JSON.parse(JSON.stringify(run)) as Run;
  }

  public async createRun(input: CreateRunInput): Promise<Run> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 25); });

    const now = new Date().toISOString();
    const newId = `run-${Date.now().toString().slice(-4)}`;

    const newRun: Run = {
      id: newId,
      goal: input.goal.trim(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      progress: 0,
      workflow: {
        id: `wf-${newId}`,
        name: "Autonomous Execution Plan",
        tasks: [
          {
            id: `task-${newId}-1`,
            name: "Initial Goal Analysis & Scope",
            status: "pending",
            description: "Parse execution requirements, inspect target boundaries, and sequence tasks.",
            attemptCount: 0,
          },
          {
            id: `task-${newId}-2`,
            name: "Execution Plan Formation",
            status: "pending",
            description: "Generate structured task graph and configure execution parameters.",
            attemptCount: 0,
          },
          {
            id: `task-${newId}-3`,
            name: "Distributed Action Execution",
            status: "pending",
            description: "Execute assigned worker tasks and capture tool outputs.",
            attemptCount: 0,
          },
          {
            id: `task-${newId}-4`,
            name: "Synthesis & Result Verification",
            status: "pending",
            description: "Synthesize findings, verify assertions, and compile final output report.",
            attemptCount: 0,
          },
        ],
      },
      tasks: [
        {
          id: `task-${newId}-1`,
          name: "Initial Goal Analysis & Scope",
          status: "pending",
          description: "Parse execution requirements, inspect target boundaries, and sequence tasks.",
          attemptCount: 0,
        },
        {
          id: `task-${newId}-2`,
          name: "Execution Plan Formation",
          status: "pending",
          description: "Generate structured task graph and configure execution parameters.",
          attemptCount: 0,
        },
        {
          id: `task-${newId}-3`,
          name: "Distributed Action Execution",
          status: "pending",
          description: "Execute assigned worker tasks and capture tool outputs.",
          attemptCount: 0,
        },
        {
          id: `task-${newId}-4`,
          name: "Synthesis & Result Verification",
          status: "pending",
          description: "Synthesize findings, verify assertions, and compile final output report.",
          attemptCount: 0,
        },
      ],
    };

    this.runs.set(newId, newRun);
    this.notify();
    return JSON.parse(JSON.stringify(newRun)) as Run;
  }

  public async updateRun(id: string, updates: Partial<Run>): Promise<Run> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 15); });

    const existing = this.runs.get(id);
    if (!existing) {
      throw new Error(`Run ${id} not found`);
    }

    const updated: Run = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.runs.set(id, updated);
    this.notify();
    return JSON.parse(JSON.stringify(updated)) as Run;
  }

  public async resetToDefaults(): Promise<void> {
    this.runs.clear();
    for (const run of SEED_RUNS) {
      this.runs.set(run.id, { ...run });
    }
    this.notify();
    await new Promise((resolve) => { setTimeout(resolve, 15); });
  }
}

export const mockRunRepository = new MockRunRepository();
