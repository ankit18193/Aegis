/**
 * In-memory implementation of IEventSubscriber for hermetic unit testing and in-process event routing.
 * Allows subscribing before starting, supports wildcard '*' matching and deduplication.
 */

import type {
  ConsumerRecordMetadata,
  EventConsumerErrorContract,
  EventHandler,
  EventType,
  IEventDeduplicator,
  IEventSubscriber,
  EventEnvelope,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { ConsumerNotConnectedError, HandlerExecutionError } from "./errors.js";

export class InMemoryEventSubscriber implements IEventSubscriber {
  private readonly handlers = new Map<EventType | "*", Set<EventHandler>>();
  private _isRunning = false;

  constructor(private readonly deduplicator?: IEventDeduplicator) {}

  public subscribe(type: EventType | "*", handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set<EventHandler>();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  public unsubscribe(type: EventType | "*", handler: EventHandler): void {
    const set = this.handlers.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  public start(): Promise<Result<void, EventConsumerErrorContract>> {
    this._isRunning = true;
    return Promise.resolve(ok(undefined));
  }

  public stop(): Promise<Result<void, EventConsumerErrorContract>> {
    this._isRunning = false;
    return Promise.resolve(ok(undefined));
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Dispatches an event envelope in-memory to all registered matching handlers.
   * Suppresses duplicate events if a deduplicator was configured.
   */
  public async dispatch(
    envelope: EventEnvelope,
    customMetadata?: Partial<ConsumerRecordMetadata>,
  ): Promise<Result<void, EventConsumerErrorContract>> {
    if (!this._isRunning) {
      return err(
        new ConsumerNotConnectedError("InMemoryEventSubscriber is not running. Call start() before dispatching."),
      );
    }

    if (this.deduplicator?.isDuplicate(envelope.id)) {
      // Best-effort duplicate suppression: silently skip processing
      return ok(undefined);
    }

    const matchingHandlers: EventHandler[] = [];

    const specificHandlers = this.handlers.get(envelope.type);
    if (specificHandlers) {
      matchingHandlers.push(...specificHandlers);
    }

    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      matchingHandlers.push(...wildcardHandlers);
    }

    const metadata: ConsumerRecordMetadata = {
      topic: customMetadata?.topic ?? "in-memory.events",
      partition: customMetadata?.partition ?? 0,
      offset: customMetadata?.offset ?? "0",
      timestamp: customMetadata?.timestamp ?? envelope.time,
      key: customMetadata?.key ?? envelope.aggregateId,
    };

    for (const handler of matchingHandlers) {
      try {
        const result = await handler(envelope, metadata);
        if (!result.ok) {
          return err(result.error);
        }
      } catch (error) {
        return err(
          new HandlerExecutionError(
            `Handler threw an unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        );
      }
    }

    return ok(undefined);
  }

  /**
   * Helper to inspect the count of registered handlers for a given type.
   */
  public getHandlerCount(type?: EventType | "*"): number {
    if (type) {
      return this.handlers.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }
}
