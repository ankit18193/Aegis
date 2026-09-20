import type { IRunApiClient } from "@aegis/contracts";

import { HttpRunApiClient } from "../../../api/httpClient";
import type { CreateRunInput } from "../schemas/runSchemas";
import type { Run, RunListItem } from "../types";

import { mockRunRepository } from "./mockRunRepository";

let activeApiClient: IRunApiClient = new HttpRunApiClient();
let mockOverride: boolean | null = null;
const subscribers = new Set<() => void>();

export function setApiClient(client: IRunApiClient): void {
  activeApiClient = client;
}

export function getApiClient(): IRunApiClient {
  return activeApiClient;
}

export function setUseMock(useMock: boolean | null): void {
  mockOverride = useMock;
}

export function isMockEnabled(): boolean {
  if (mockOverride !== null) {
    return mockOverride;
  }
  if (import.meta.env.MODE === "test") {
    return true;
  }
  if (import.meta.env.VITE_USE_MOCK !== undefined) {
    return import.meta.env.VITE_USE_MOCK === "true";
  }
  return false;
}

function notifySubscribers(): void {
  for (const listener of subscribers) {
    try {
      listener();
    } catch {
      // Ignore subscriber callback errors
    }
  }
}

export const runService = {
  /**
   * Fetches all runs (summary items for navigation).
   * Queries the Fastify HTTP API when live; gracefully falls back to mock repository
   * if VITE_USE_MOCK is enabled or if the backend API service is unreachable.
   */
  async getRuns(): Promise<RunListItem[]> {
    if (isMockEnabled()) {
      return mockRunRepository.getAllRuns();
    }

    const result = await activeApiClient.listRuns();
    if (result.ok) {
      return result.value.items;
    }

    if (result.error.error.code === "SERVICE_UNAVAILABLE") {
      console.warn("Aegis API unavailable. Falling back to local mock repository.", result.error);
      return mockRunRepository.getAllRuns();
    }

    throw new Error(result.error.error.message);
  },

  /**
   * Fetches full run details by ID.
   */
  async getRun(id: string): Promise<Run | null> {
    if (isMockEnabled()) {
      return mockRunRepository.getRunById(id);
    }

    const result = await activeApiClient.getRun(id);
    if (result.ok) {
      return result.value.run;
    }

    if (result.error.error.code === "NOT_FOUND") {
      return null;
    }

    if (result.error.error.code === "SERVICE_UNAVAILABLE") {
      console.warn(`Aegis API unavailable when retrieving run ${id}. Falling back to local mock.`);
      return mockRunRepository.getRunById(id);
    }

    throw new Error(result.error.error.message);
  },

  /**
   * Creates a new execution run.
   */
  async createRun(input: CreateRunInput): Promise<Run> {
    if (isMockEnabled()) {
      return mockRunRepository.createRun(input);
    }

    const result = await activeApiClient.createRun(input);

    if (result.ok) {
      notifySubscribers();
      return result.value.run;
    }

    if (result.error.error.code === "SERVICE_UNAVAILABLE") {
      console.warn("Aegis API unavailable when creating run. Falling back to local mock.");
      return mockRunRepository.createRun(input);
    }

    throw new Error(result.error.error.message);
  },

  /**
   * Cancels an active execution run.
   */
  async cancelRun(id: string, reason?: string): Promise<Run> {
    if (isMockEnabled()) {
      const existing = await mockRunRepository.getRunById(id);
      if (!existing) {
        throw new Error(`Run ${id} not found`);
      }
      return mockRunRepository.updateRun(id, { status: "cancelled" });
    }

    const result = await activeApiClient.cancelRun(id, reason ? { reason } : undefined);
    if (result.ok) {
      notifySubscribers();
      return result.value.run;
    }

    if (result.error.error.code === "SERVICE_UNAVAILABLE") {
      return mockRunRepository.updateRun(id, { status: "cancelled" });
    }

    throw new Error(result.error.error.message);
  },

  /**
   * Resets mock data back to clean factory seed defaults.
   */
  async resetRuns(): Promise<void> {
    await mockRunRepository.resetToDefaults();
    notifySubscribers();
  },

  /**
   * Subscribes to run changes from the repository or HTTP client actions.
   */
  subscribe(listener: () => void): () => void {
    subscribers.add(listener);
    const unsubMock = mockRunRepository.subscribe(listener);
    return () => {
      subscribers.delete(listener);
      unsubMock();
    };
  },
};
