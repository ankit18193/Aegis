import type { PlatformHealth } from "@aegis/foundation";
import type { AgentId, WorkflowId, Result } from "@aegis/types";

// ─────────────────────────────────────────────────────────────────────────────
// IHealthCheckable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract that any platform component exposing a health endpoint must satisfy.
 *
 * Every service (API, Worker, etc.) should implement this interface so the
 * platform can uniformly probe component health.
 */
export interface IHealthCheckable {
  /**
   * Returns the current health of this component.
   * Must never throw — errors should be captured and reflected in the status.
   */
  checkHealth(): Promise<PlatformHealth>;
}

// ─────────────────────────────────────────────────────────────────────────────
// IAgentRepository (future placeholder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository contract for Agent persistence.
 *
 * NOTE: This is a forward declaration only.
 * No implementation exists in Phase 0.
 * The concrete implementation will depend on the chosen persistence layer.
 */
export interface IAgentRepository {
  findById(id: AgentId): Promise<Result<AgentRecord | null>>;
  save(agent: AgentRecord): Promise<Result<void>>;
  delete(id: AgentId): Promise<Result<void>>;
}

/**
 * Minimal placeholder structure for an agent record.
 *
 * NOTE: This will be expanded substantially in future phases
 * when agent execution is implemented.
 */
export interface AgentRecord {
  readonly id: AgentId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// IWorkflowRepository (future placeholder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository contract for Workflow persistence.
 *
 * NOTE: Forward declaration only. Phase 0.
 */
export interface IWorkflowRepository {
  findById(id: WorkflowId): Promise<Result<WorkflowRecord | null>>;
  save(workflow: WorkflowRecord): Promise<Result<void>>;
}

/**
 * Minimal placeholder structure for a workflow record.
 */
export interface WorkflowRecord {
  readonly id: WorkflowId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// IEventPublisher (future placeholder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract for publishing events to the event bus.
 *
 * NOTE: Forward declaration only. Kafka integration is deferred to a future phase.
 * The concrete implementation will wrap the Kafka producer.
 */
export interface IEventPublisher {
  publish(topic: string, payload: unknown): Promise<Result<void>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Domain Entity Contracts & Schemas
// ─────────────────────────────────────────────────────────────────────────────

export * from "./runs.js";
export * from "./events.js";
export * from "./api.js";
export * from "./errors.js";
export * from "./client.js";


