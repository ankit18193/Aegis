/**
 * Event contracts and types re-exported for the Aegis API application.
 * Preserves the single canonical contract defined in @aegis/contracts.
 */

export type {
  ConsumerRecordMetadata,
  EventConsumerErrorCode,
  EventConsumerErrorContract,
  EventHandler,
  IEventDeduplicator,
  IEventPublisher,
  IEventSubscriber,
  EventEnvelope,
  EventPublishErrorCode,
  EventPublishErrorContract,
  EventPublishResult,
} from "@aegis/contracts";
export {
  consumerRecordMetadataSchema,
  eventConsumerErrorCodeSchema,
  eventEnvelopeSchema,
  eventPublishErrorCodeSchema,
  eventPublishResultSchema,
} from "@aegis/contracts";
