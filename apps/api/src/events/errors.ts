/**
 * Concrete error classes for the Aegis event transport subsystem.
 * Implements canonical EventPublishErrorContract from @aegis/contracts.
 */

import type { EventPublishErrorCode, EventPublishErrorContract } from "@aegis/contracts";

export class EventPublishError extends Error implements EventPublishErrorContract {
  public override readonly cause?: unknown;

  constructor(
    public readonly code: EventPublishErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "EventPublishError";
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SerializationError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("SERIALIZATION_FAILED", message, cause);
    this.name = "SerializationError";
  }
}

export class DeserializationError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("DESERIALIZATION_FAILED", message, cause);
    this.name = "DeserializationError";
  }
}

export class InvalidEnvelopeError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("INVALID_ENVELOPE", message, cause);
    this.name = "InvalidEnvelopeError";
  }
}
