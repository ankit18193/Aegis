/**
 * In-memory implementation of IEventPublisher for hermetic unit testing and development.
 * Records published envelopes without requiring external message broker infrastructure.
 */

import type {
  EventEnvelope,
  EventPublishResult,
  IEventPublisher,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type { EventPublishError } from "./errors.js";

export class InMemoryEventPublisher implements IEventPublisher {
  private readonly _published: EventEnvelope[] = [];
  private _simulatedError: EventPublishError | null = null;

  constructor(private readonly topic = "aegis.events") {}

  /**
   * Configures a simulated failure for testing failure containment.
   */
  simulateFailure(error: EventPublishError | null): void {
    this._simulatedError = error;
  }

  publish(
    envelope: EventEnvelope,
  ): Promise<Result<EventPublishResult, EventPublishError>> {
    if (this._simulatedError) {
      return Promise.resolve(err(this._simulatedError));
    }

    this._published.push(envelope);
    return Promise.resolve(
      ok({
        success: true,
        topic: this.topic,
        partition: 0,
        offset: String(this._published.length - 1),
      }),
    );
  }

  publishBatch(
    envelopes: readonly EventEnvelope[],
  ): Promise<Result<readonly EventPublishResult[], EventPublishError>> {
    if (this._simulatedError) {
      return Promise.resolve(err(this._simulatedError));
    }

    const results: EventPublishResult[] = [];
    for (const env of envelopes) {
      this._published.push(env);
      results.push({
        success: true,
        topic: this.topic,
        partition: 0,
        offset: String(this._published.length - 1),
      });
    }

    return Promise.resolve(ok(results));
  }

  getPublishedEnvelopes(): readonly EventEnvelope[] {
    return [...this._published];
  }

  clear(): void {
    this._published.length = 0;
    this._simulatedError = null;
  }
}
