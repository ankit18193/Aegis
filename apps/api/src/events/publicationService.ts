/**
 * EventPublicationService — Application-level bridge for event publishing.
 * Bridges domain and run execution events to canonical EventEnvelopes and dispatches them
 * via IEventPublisher.
 *
 * Strict single mapping path:
 * DomainEvent -> mapDomainEventToRunEvent() -> RunEvent -> publishRunEvents() -> toEventEnvelope() -> IEventPublisher.publishBatch()
 */

import type {
  EventEnvelope,
  EventPublishErrorContract,
  EventPublishResult,
  IEventPublisher,
  RunEvent,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

import type { DomainEvent } from "../domain/events.js";
import { mapDomainEventToRunEvent } from "../services/runMapper.js";

import type { CreateEnvelopeOptions } from "./envelope.js";
import { toEventEnvelope } from "./envelope.js";

export interface EventPublicationServiceOptions {
  readonly source?: string | undefined;
  readonly logger?: Logger | undefined;
}

export class EventPublicationService {
  private readonly defaultSource: string;
  private readonly logger?: Logger | undefined;

  constructor(
    private readonly publisher: IEventPublisher,
    options: EventPublicationServiceOptions = {},
  ) {
    this.defaultSource = options.source ?? "aegis.execution";
    this.logger = options.logger;
  }

  /**
   * Publishes canonical RunEvents through the event publisher.
   * Maps each RunEvent into an EventEnvelope, preserving event ID, run ID, and correlation ID.
   */
  public async publishRunEvents(
    runEvents: readonly RunEvent[],
    options?: CreateEnvelopeOptions,
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (runEvents.length === 0) {
      return ok([]);
    }

    const envelopes: EventEnvelope[] = runEvents.map((event) =>
      toEventEnvelope(event, {
        source: options?.source ?? this.defaultSource,
        correlationId: options?.correlationId ?? event.runId,
        causationId: options?.causationId,
      }),
    );

    const result = await this.publisher.publishBatch(envelopes);
    if (!result.ok) {
      this.logger?.warn("Failed to publish event envelopes via event publisher", {
        error: result.error.message,
        errorCode: result.error.code,
        envelopeCount: envelopes.length,
      });
      return result;
    }

    return result;
  }

  /**
   * Publishes domain events.
   * Strictly delegates to mapDomainEventToRunEvent() then publishRunEvents(),
   * maintaining a single mapping source of truth.
   */
  public async publishDomainEvents(
    domainEvents: readonly DomainEvent[],
    options?: CreateEnvelopeOptions,
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (domainEvents.length === 0) {
      return ok([]);
    }

    const runEvents: RunEvent[] = domainEvents.map(mapDomainEventToRunEvent);
    return this.publishRunEvents(runEvents, options);
  }
}
