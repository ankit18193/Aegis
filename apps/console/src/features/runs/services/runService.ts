import type { CreateRunInput } from "../schemas/runSchemas";
import type { Run, RunListItem } from "../types";

import { mockRunRepository } from "./mockRunRepository";

export const runService = {
  /**
   * Fetches all runs (summary items for navigation).
   */
  async getRuns(): Promise<RunListItem[]> {
    return mockRunRepository.getAllRuns();
  },

  /**
   * Fetches full run details by ID.
   */
  async getRun(id: string): Promise<Run | null> {
    return mockRunRepository.getRunById(id);
  },

  /**
   * Creates a new execution run.
   */
  async createRun(input: CreateRunInput): Promise<Run> {
    return mockRunRepository.createRun(input);
  },

  /**
   * Resets mock data back to clean factory seed defaults.
   */
  async resetRuns(): Promise<void> {
    return mockRunRepository.resetToDefaults();
  },

  /**
   * Subscribes to run changes from the repository.
   */
  subscribe(listener: () => void): () => void {
    return mockRunRepository.subscribe(listener);
  },
};
