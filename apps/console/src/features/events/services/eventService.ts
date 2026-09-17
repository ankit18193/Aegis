import { SEED_EVENTS } from "../../../mocks/seedEvents";
import type { RunEvent } from "../types";

const EVENTS_STORAGE_KEY = "aegis_console_events_v1";

class MockEventRepository {
  private eventsByRunId = new Map<string, RunEvent[]>();
  private subscribers = new Set<() => void>();
  private initialized = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (this.initialized) return;

    let loaded: Record<string, RunEvent[]> | null = null;
    try {
      if (typeof window !== "undefined") {
        const stored = window.localStorage.getItem(EVENTS_STORAGE_KEY);
        if (stored) {
          loaded = JSON.parse(stored) as Record<string, RunEvent[]>;
        }
      }
    } catch {
      loaded = null;
    }

    const source = loaded ?? SEED_EVENTS;
    this.eventsByRunId.clear();
    for (const [runId, list] of Object.entries(source)) {
      this.eventsByRunId.set(runId, [...list]);
    }

    this.initialized = true;
  }

  private persist(): void {
    try {
      if (typeof window !== "undefined") {
        const obj: Record<string, RunEvent[]> = {};
        for (const [runId, list] of this.eventsByRunId.entries()) {
          obj[runId] = list;
        }
        window.localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(obj));
      }
    } catch {
      // Ignore storage errors
    }
  }

  private notify(): void {
    this.persist();
    for (const sub of this.subscribers) {
      try {
        sub();
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  public subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  public async getEvents(runId: string): Promise<RunEvent[]> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    const list = this.eventsByRunId.get(runId) ?? [];
    return [...list].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  public async addEvent(
    runId: string,
    eventData: Omit<RunEvent, "id" | "runId">
  ): Promise<RunEvent> {
    this.initialize();
    await new Promise((resolve) => { setTimeout(resolve, 5); });

    const existing = this.eventsByRunId.get(runId) ?? [];
    const newEvent: RunEvent = {
      ...eventData,
      id: `ev-${Date.now().toString()}-${Math.floor(Math.random() * 1000).toString()}`,
      runId,
    };

    existing.push(newEvent);
    this.eventsByRunId.set(runId, existing);
    this.notify();
    return newEvent;
  }

  public async clearEvents(runId: string): Promise<void> {
    this.initialize();
    this.eventsByRunId.delete(runId);
    this.notify();
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }

  public async resetToDefaults(): Promise<void> {
    this.eventsByRunId.clear();
    for (const [runId, list] of Object.entries(SEED_EVENTS)) {
      this.eventsByRunId.set(runId, [...list]);
    }
    this.notify();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

export const mockEventRepository = new MockEventRepository();

export const eventService = {
  async getEvents(runId: string): Promise<RunEvent[]> {
    return mockEventRepository.getEvents(runId);
  },

  async recordEvent(
    runId: string,
    eventData: Omit<RunEvent, "id" | "runId">
  ): Promise<RunEvent> {
    return mockEventRepository.addEvent(runId, eventData);
  },

  subscribe(listener: () => void): () => void {
    return mockEventRepository.subscribe(listener);
  },

  async resetEvents(): Promise<void> {
    return mockEventRepository.resetToDefaults();
  },
};
