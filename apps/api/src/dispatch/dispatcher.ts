import type {
  DispatchOptions,
  DispatchResult,
  ITaskAssignmentPublisher,
  ITaskDispatcher,
  ITopicProvisioner,
  IWorkerRegistry,
  IWorkerSelector,
  Task,
} from "@aegis/contracts";
import { resolveWorkerAssignmentTopic } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { runId } from "@aegis/types";

import { buildTaskAssignment } from "./assignmentBuilder.js";

export interface TaskDispatcherOptions {
  readonly registry: IWorkerRegistry;
  readonly selector: IWorkerSelector;
  readonly publisher: ITaskAssignmentPublisher;
  readonly topicProvisioner?: ITopicProvisioner | undefined;
  readonly baseAssignmentTopic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * TaskDispatcher — Control-plane distributed task dispatcher.
 *
 * Implements Phase 11E core dispatch pipeline:
 * 1. Queries live worker candidates from control-plane IWorkerRegistry.
 * 2. Deterministically selects optimal worker via IWorkerSelector (Lock 7).
 * 3. Resolves dedicated worker-targeted topic: aegis.tasks.assign.${workerId} (Lock 8).
 *    STRICT: Zero fallback to unrouted shared topics.
 * 4. Ensures topic provisioning via ITopicProvisioner.
 * 5. Mints unique assignment and CloudEvents envelope (Lock 9: distinct IDs).
 * 6. Publishes envelope via ITaskAssignmentPublisher.
 * 7. Returns structured DispatchResult.
 *
 * Invariants Enforced:
 * - LOCK 3: Presence is advisory; dispatcher queries current registry snapshot.
 * - LOCK 5: No AgentRuntime duplication; dispatcher only routes and publishes.
 * - LOCK 6: Zero database queries in scheduler; pure domain logic and transport.
 * - LOCK 8: Worker-targeted routing strictly required.
 */
export class TaskDispatcher implements ITaskDispatcher {
  private readonly registry: IWorkerRegistry;
  private readonly selector: IWorkerSelector;
  private readonly publisher: ITaskAssignmentPublisher;
  private readonly topicProvisioner?: ITopicProvisioner | undefined;
  private readonly baseAssignmentTopic: string;
  private readonly logger?: Logger | undefined;

  constructor(options: TaskDispatcherOptions) {
    this.registry = options.registry;
    this.selector = options.selector;
    this.publisher = options.publisher;
    this.topicProvisioner = options.topicProvisioner;
    this.baseAssignmentTopic = options.baseAssignmentTopic ?? "aegis.tasks.assign";
    this.logger = options.logger;
  }

  public async dispatch(
    task: Task,
    options?: DispatchOptions,
  ): Promise<DispatchResult> {
    const effectiveRunId = options?.runId ?? runId(`run-${task.id}`);

    // 1. Query live worker snapshot from control-plane presence registry
    const candidates = this.registry.list();

    // 2. Select eligible worker via deterministic selector
    const selection = this.selector.selectWorker(task, candidates);
    if (!selection.selectedWorker) {
      this.logger?.warn("Task dispatch failed: no eligible worker found", {
        taskId: task.id,
        taskName: task.name,
        reason: selection.failureReason,
        evaluatedCandidates: selection.evaluatedWorkerCount,
      });

      return {
        status: "NO_ELIGIBLE_WORKER",
        taskId: task.id,
        runId: effectiveRunId,
        reason: selection.failureReason ?? "NO_HEALTHY_WORKERS",
      };
    }

    const selectedWorker = selection.selectedWorker;
    const workerId = selectedWorker.workerId;

    // 3. Resolve worker-targeted assignment topic (Lock 8: Strict routing, zero fallback)
    let targetTopic: string;
    try {
      targetTopic = resolveWorkerAssignmentTopic(this.baseAssignmentTopic, workerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error("Failed to resolve worker assignment topic", {
        workerId,
        error: msg,
      });

      return {
        status: "DISPATCH_FAILED",
        taskId: task.id,
        runId: effectiveRunId,
        workerId,
        error: {
          code: "INVALID_DISPATCH_REQUEST",
          message: msg,
        },
      };
    }

    // 4. Ensure dedicated worker topic is provisioned
    if (this.topicProvisioner) {
      const provisionResult = await this.topicProvisioner.ensureTopic(targetTopic);
      if (!provisionResult.ok) {
        this.logger?.error("Failed to provision worker assignment topic", {
          targetTopic,
          workerId,
          error: provisionResult.error.message,
        });

        return {
          status: "DISPATCH_FAILED",
          taskId: task.id,
          runId: effectiveRunId,
          workerId,
          targetTopic,
          error: {
            code: "TOPIC_PROVISION_FAILED",
            message: provisionResult.error.message,
          },
        };
      }
    }

    // 5. Build canonical assignment and CloudEvents envelope (Lock 9: distinct IDs)
    const { assignment, envelope } = buildTaskAssignment({
      task,
      workerId,
      runId: effectiveRunId,
      correlationId: options?.correlationId,
      causationId: options?.causationId,
    });

    // 6. Publish assignment envelope to worker-targeted topic
    const publishResult = await this.publisher.publish(targetTopic, envelope);
    if (!publishResult.ok) {
      this.logger?.error("Failed to publish task assignment envelope", {
        targetTopic,
        taskId: task.id,
        assignmentId: assignment.assignmentId,
        workerId,
        error: publishResult.error.message,
      });

      return {
        status: "DISPATCH_FAILED",
        taskId: task.id,
        runId: assignment.runId,
        assignmentId: assignment.assignmentId,
        workerId,
        targetTopic,
        error: {
          code: "DISPATCH_PUBLISH_FAILED",
          message: publishResult.error.message,
        },
      };
    }

    this.logger?.info("Task successfully dispatched to worker", {
      taskId: task.id,
      assignmentId: assignment.assignmentId,
      workerId,
      targetTopic,
      runId: assignment.runId,
    });

    return {
      status: "ASSIGNED",
      taskId: task.id,
      runId: assignment.runId,
      assignmentId: assignment.assignmentId,
      workerId,
      targetTopic,
    };
  }
}
