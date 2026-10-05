/**
 * Outbox Repository Interface & Types — Phase 12C: Transactional Outbox Pattern
 * Re-exports canonical contracts and declares persistence boundaries for the transactional outbox.
 */

export type {
  CreateOutboxRecord,
  IOutboxRepository,
  OutboxClaimRequest,
  OutboxConfig,
  OutboxRecord,
  OutboxStatus,
} from "@aegis/contracts";

export {
  DEFAULT_OUTBOX_CONFIG,
  OutboxClaimConflictError,
  OutboxError,
  OutboxRecordNotFoundError,
  OutboxSerializationError,
} from "@aegis/contracts";
