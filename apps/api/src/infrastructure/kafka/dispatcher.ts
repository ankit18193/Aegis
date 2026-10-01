/**
 * In-process event dispatcher.
 * Routes deserialized EventEnvelopes to type-specific and wildcard handlers.
 */

import type {
  ConsumerRecordMetadata,
  EventConsumerErrorContract,
  EventHandler,
  EventType,
  EventEnvelope,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { HandlerExecutionError } from "../../events/errors.js";

export class EventDispatcher {
  private readonly handlers = new Map<EventType | "*", Set<EventHandler>>();

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

  public async dispatch(
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ): Promise<Result<void, EventConsumerErrorContract>> {
    const matchingHandlers: EventHandler[] = [];

    const specificHandlers = this.handlers.get(envelope.type);
    if (specificHandlers) {
      matchingHandlers.push(...specificHandlers);
    }

    const wildcardHandlers = this.handlers.get("*");
    if (wildcardHandlers) {
      matchingHandlers.push(...wildcardHandlers);
    }

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

  public hasSubscriptions(): boolean {
    return this.handlers.size > 0;
  }

  public getSubscribedTypes(): readonly (EventType | "*")[] {
    return Array.from(this.handlers.keys());
  }

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
