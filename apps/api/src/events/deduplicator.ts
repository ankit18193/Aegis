/**
 * Best-effort in-process duplicate suppression for at-least-once delivery.
 *
 * NOTE: This deduplicator is an optimization for reducing repeated processing,
 * not a durable exactly-once guarantee. In-process memory state is reset upon
 * process restart or rebalance.
 */

import type { IEventDeduplicator } from "./types.js";

export class InMemoryDeduplicator implements IEventDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(public readonly maxEntries = 10_000) {
    if (maxEntries <= 0) {
      throw new Error(`InMemoryDeduplicator maxEntries must be greater than 0, got ${String(maxEntries)}`);
    }
  }

  /**
   * Checks whether an event ID has already been seen.
   * If seen, returns true.
   * If not seen, records the event ID in the sliding window and returns false.
   */
  public isDuplicate(eventId: string): boolean {
    if (this.seen.has(eventId)) {
      return true;
    }

    if (this.order.length >= this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }

    this.order.push(eventId);
    this.seen.add(eventId);
    return false;
  }

  /**
   * Resets all tracked event IDs.
   */
  public clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }

  /**
   * Current number of tracked event IDs in memory.
   */
  public get size(): number {
    return this.seen.size;
  }
}
