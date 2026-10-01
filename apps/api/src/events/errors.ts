/**
 * Concrete error classes for the Aegis event transport subsystem.
 * Implements canonical EventPublishErrorContract from @aegis/contracts.
 */

import type {
  EventConsumerErrorCode,
  EventConsumerErrorContract,
  EventPublishErrorCode,
  EventPublishErrorContract,
} from "@aegis/contracts";

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

export class KafkaNotConnectedError extends EventPublishError {
  constructor(message = "Kafka producer is not connected", cause?: unknown) {
    super("KAFKA_NOT_CONNECTED", message, cause);
    this.name = "KafkaNotConnectedError";
  }
}

export class KafkaConnectionFailedError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("KAFKA_CONNECTION_FAILED", message, cause);
    this.name = "KafkaConnectionFailedError";
  }
}

export class KafkaPublishTimeoutError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("KAFKA_PUBLISH_TIMEOUT", message, cause);
    this.name = "KafkaPublishTimeoutError";
  }
}

export class KafkaBrokerUnavailableError extends EventPublishError {
  constructor(message: string, cause?: unknown) {
    super("BROKER_UNAVAILABLE", message, cause);
    this.name = "KafkaBrokerUnavailableError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumer Error Classes (Phase 10B)
// ─────────────────────────────────────────────────────────────────────────────

export class EventConsumerError extends Error implements EventConsumerErrorContract {
  public override readonly cause?: unknown;

  constructor(
    public readonly code: EventConsumerErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "EventConsumerError";
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConsumerNotConnectedError extends EventConsumerError {
  constructor(message = "Consumer is not connected", cause?: unknown) {
    super("CONSUMER_NOT_CONNECTED", message, cause);
    this.name = "ConsumerNotConnectedError";
  }
}

export class SubscriptionError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("SUBSCRIPTION_FAILED", message, cause);
    this.name = "SubscriptionError";
  }
}

export class HandlerExecutionError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("HANDLER_FAILED", message, cause);
    this.name = "HandlerExecutionError";
  }
}

export class ConsumerDeserializationError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("DESERIALIZATION_FAILED", message, cause);
    this.name = "ConsumerDeserializationError";
  }
}

export class ConsumerInvalidEnvelopeError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("INVALID_ENVELOPE", message, cause);
    this.name = "ConsumerInvalidEnvelopeError";
  }
}

export class DuplicateEventError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("DUPLICATE_EVENT", message, cause);
    this.name = "DuplicateEventError";
  }
}

export class DispatchError extends EventConsumerError {
  constructor(message: string, cause?: unknown) {
    super("DISPATCH_ERROR", message, cause);
    this.name = "DispatchError";
  }
}

