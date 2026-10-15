/**
 * SseEventGateway — Phase 13C (Commit 2)
 *
 * Bridges the Kafka event consumption layer to the SSE transport layer.
 * Subscribes to all canonical execution event types via IEventSubscriber,
 * adapts each consumed event through the Phase 13C Commit 1 adapter
 * (mapExecutionEventToSseEnvelope), and fans out the resulting
 * SseTransportEnvelope to all active SSE connections for the event's runId
 * via SseTransportManager.broadcastToRun.
 *
 * Architectural Invariants:
 * 1. Gateway delivers events — it does NOT own execution state. PostgreSQL is authoritative.
 * 2. Gateway does NOT write to the outbox, database, or emit new domain events.
 * 3. Fan-out is run-scoped: only connections subscribed to a specific runId receive its events.
 * 4. Delivery is best-effort per SSE connection: individual write failures are logged,
 *    not propagated back to the Kafka consumer handler (offset still committed).
 * 5. The handler always returns ok(undefined): it is a pure observer that must not
 *    poison-pill the Kafka offset pipeline with SSE delivery errors.
 * 6. Instance isolation: each API replica subscribes independently, enabling per-instance
 *    fan-out when using unique consumer group IDs (see Phase 13C deployment note).
 */

import type {
  ConsumerRecordMetadata,
  EventConsumerErrorContract,
  EventEnvelope,
  IEventSubscriber,
  RunEvent,
} from "@aegis/contracts";
import { mapExecutionEventToSseEnvelope, SUPPORTED_EXECUTION_EVENT_TYPES } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

import type { SseTransportManager } from "./sseTransportManager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Options and Metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface SseEventGatewayOptions {
  /** The event subscriber to register handlers against (e.g. KafkaEventConsumer). */
  readonly subscriber: IEventSubscriber;
  /** The SSE transport manager responsible for active connection fan-out. */
  readonly transportManager: SseTransportManager;
  /** Optional structured logger. */
  readonly logger?: Logger | undefined;
}

export interface SseGatewayDeliveryMetrics {
  /** Total number of Kafka events consumed and processed by the gateway. */
  eventsConsumed: number;
  /** Number of events successfully adapted and delivered to at least one connection. */
  eventsDelivered: number;
  /** Number of events dropped due to adapter errors (unsupported type, malformed payload). */
  eventsDropped: number;
  /** Number of events skipped due to no active SSE connections for the target runId. */
  eventsSkipped: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SseEventGateway
// ─────────────────────────────────────────────────────────────────────────────

export class SseEventGateway {
  private readonly subscriber: IEventSubscriber;
  private readonly transportManager: SseTransportManager;
  private readonly logger?: Logger | undefined;

  private _registered = false;

  /** Bound handler reference — required for deterministic unsubscription. */
  private readonly boundHandler: (
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ) => Promise<Result<void, EventConsumerErrorContract>>;

  private readonly _metrics: SseGatewayDeliveryMetrics = {
    eventsConsumed: 0,
    eventsDelivered: 0,
    eventsDropped: 0,
    eventsSkipped: 0,
  };

  constructor(options: SseEventGatewayOptions) {
    this.subscriber = options.subscriber;
    this.transportManager = options.transportManager;
    this.logger = options.logger;
    this.boundHandler = this.handleEvent.bind(this);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers the SSE delivery handler against all supported execution event types.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  register(): void {
    if (this._registered) return;

    for (const type of SUPPORTED_EXECUTION_EVENT_TYPES) {
      this.subscriber.subscribe(type, this.boundHandler);
    }

    this._registered = true;
    this.logger?.info("SseEventGateway registered for all supported execution event types", {
      types: SUPPORTED_EXECUTION_EVENT_TYPES,
      activeConnections: this.transportManager.activeConnectionCount,
    });
  }

  /**
   * Unregisters the SSE delivery handler from all event types.
   * Safe to call when gateway is not registered; subsequent calls are no-ops.
   */
  unregister(): void {
    if (!this._registered) return;

    for (const type of SUPPORTED_EXECUTION_EVENT_TYPES) {
      this.subscriber.unsubscribe(type, this.boundHandler);
    }

    this._registered = false;
    this.logger?.info("SseEventGateway unregistered from all execution event types");
  }

  get isRegistered(): boolean {
    return this._registered;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core Delivery Handler
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles a consumed execution event from the subscriber (Kafka consumer).
   *
   * Pipeline:
   * 1. Extract runId from the EventEnvelope.
   * 2. Short-circuit if no active SSE connections exist for the runId.
   * 3. Adapt the raw EventEnvelope to a canonical SseTransportEnvelope via the
   *    Phase 13C Commit 1 adapter (mapExecutionEventToSseEnvelope).
   * 4. Broadcast the transport envelope to all active connections for the runId.
   * 5. Always return ok(undefined) — SSE delivery failures MUST NOT affect
   *    the Kafka consumer offset pipeline.
   */
  async handleEvent(
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ): Promise<Result<void, EventConsumerErrorContract>> {
    this._metrics.eventsConsumed += 1;

    const runId = envelope.aggregateId;

    // Step 2: Short-circuit — no connections for this run means no delivery work
    const activeConnections = this.transportManager.getConnectionsByRunId(runId);
    if (activeConnections.length === 0) {
      this._metrics.eventsSkipped += 1;
      this.logger?.debug("SseEventGateway: no active connections for run; skipping delivery", {
        runId,
        eventId: envelope.id,
        type: envelope.type,
        topic: metadata.topic,
        offset: metadata.offset,
      });
      return ok(undefined);
    }

    // Step 3: Adapt EventEnvelope to SseTransportEnvelope using the Phase 13C adapter.
    // The adapter handles RunEvent, EventEnvelope, and TaskAssignmentEnvelope polymorphically.
    const adaptResult = mapExecutionEventToSseEnvelope(envelope);

    if (!adaptResult.ok) {
      this._metrics.eventsDropped += 1;
      this.logger?.warn("SseEventGateway: failed to adapt execution event for SSE delivery", {
        runId,
        eventId: envelope.id,
        type: envelope.type,
        topic: metadata.topic,
        offset: metadata.offset,
        adapterError: adaptResult.error.code,
        adapterMessage: adaptResult.error.message,
      });
      // Intentionally return ok — do not fail the Kafka offset pipeline on adapter errors
      return ok(undefined);
    }

    const sseEnvelope = adaptResult.value;

    // Step 4: Fan-out to all active SSE connections for the run
    try {
      const deliveredCount = await this.transportManager.broadcastToRun(runId, sseEnvelope);

      if (deliveredCount > 0) {
        this._metrics.eventsDelivered += 1;
        this.logger?.debug("SseEventGateway: broadcast execution event to SSE connections", {
          runId,
          eventId: envelope.id,
          type: envelope.type,
          deliveredCount,
          topic: metadata.topic,
          offset: metadata.offset,
        });
      } else {
        // All connections for the run closed between the activeConnections check and broadcast
        this._metrics.eventsSkipped += 1;
        this.logger?.debug(
          "SseEventGateway: all connections closed before broadcast completed; event skipped",
          {
            runId,
            eventId: envelope.id,
            type: envelope.type,
          },
        );
      }
    } catch (broadcastError) {
      // Unexpected error in broadcast — log and continue; never propagate to Kafka consumer
      this._metrics.eventsDropped += 1;
      this.logger?.error("SseEventGateway: unexpected error during broadcastToRun", {
        runId,
        eventId: envelope.id,
        type: envelope.type,
        error:
          broadcastError instanceof Error ? broadcastError.message : String(broadcastError),
      });
    }

    // Step 5: Always return ok — SSE delivery result is independent of Kafka offset management
    return ok(undefined);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Observability
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of the current delivery metrics.
   */
  getMetrics(): Readonly<SseGatewayDeliveryMetrics> {
    return { ...this._metrics };
  }

  /**
   * Resets delivery metrics to zero. Useful in testing and operational tooling.
   */
  resetMetrics(): void {
    this._metrics.eventsConsumed = 0;
    this._metrics.eventsDelivered = 0;
    this._metrics.eventsDropped = 0;
    this._metrics.eventsSkipped = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal: RunEvent overload for direct injection (testing without Kafka)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Delivers a raw RunEvent directly to SSE subscribers for a given runId.
   * Bypasses the EventEnvelope wrapper — useful for integration testing and
   * for callers that hold a RunEvent before it has been promoted to an EventEnvelope.
   *
   * NOTE: This method does NOT interact with Kafka. It is a pure SSE delivery path.
   */
  async deliverRunEvent(
    runEvent: RunEvent,
    runId: string,
  ): Promise<{ delivered: number; dropped: boolean }> {
    const activeConnections = this.transportManager.getConnectionsByRunId(runId);
    if (activeConnections.length === 0) {
      return { delivered: 0, dropped: false };
    }

    const adaptResult = mapExecutionEventToSseEnvelope(runEvent);
    if (!adaptResult.ok) {
      this.logger?.warn("SseEventGateway.deliverRunEvent: adapter error", {
        runId,
        eventId: runEvent.id,
        type: runEvent.type,
        adapterError: adaptResult.error.code,
      });
      return { delivered: 0, dropped: true };
    }

    const deliveredCount = await this.transportManager.broadcastToRun(runId, adaptResult.value);
    return { delivered: deliveredCount, dropped: false };
  }
}
