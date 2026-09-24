/**
 * Event contracts and types re-exported for the Aegis API application.
 * Preserves the single canonical contract defined in @aegis/contracts.
 */

export type {
  EventEnvelope,
  EventPublishErrorCode,
  EventPublishErrorContract,
  EventPublishResult,
  IEventPublisher,
} from "@aegis/contracts";
export {
  eventEnvelopeSchema,
  eventPublishErrorCodeSchema,
  eventPublishResultSchema,
} from "@aegis/contracts";
