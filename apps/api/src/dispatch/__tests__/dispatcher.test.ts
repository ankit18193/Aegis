import type { Task, WorkerDescriptor } from "@aegis/contracts";
import { runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InMemoryTopicProvisioner } from "../../presence/topicProvisioner.js";
import { InMemoryWorkerRegistry } from "../../presence/workerRegistry.js";
import { InMemoryTaskAssignmentPublisher } from "../assignmentPublisher.js";
import { TaskDispatcher } from "../dispatcher.js";
import { DeterministicWorkerSelector } from "../workerSelector.js";

describe("TaskDispatcher (Phase 11E — Commit 3)", () => {
  function createMockTask(overrides?: Partial<Task>): Task {
    return {
      id: taskId("task-dispatch-1"),
      name: "python_runner",
      status: "pending",
      description: "Run python script",
      attemptCount: 0,
      version: 1,
      dependencies: [],
      ...overrides,
    };
  }

  function createMockWorker(id: string): WorkerDescriptor {
    return {
      workerId: workerId(id),
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: {
        taskTypes: ["*"],
        tools: ["python"],
        maxConcurrency: 4,
      },
      activeTaskCount: 0,
      maxConcurrentTasks: 4,
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
  }

  it("successfully selects worker and dispatches to dedicated topic (Lock 8 & 9)", async () => {
    const registry = new InMemoryWorkerRegistry();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();
    const topicProvisioner = new InMemoryTopicProvisioner();

    const worker = createMockWorker("worker-alpha");
    registry.register(worker);

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    const task = createMockTask();
    const result = await dispatcher.dispatch(task, { runId: runId("run-test-101") });

    expect(result.status).toBe("ASSIGNED");
    expect(result.workerId).toBe("worker-alpha");
    expect(result.targetTopic).toBe("aegis.tasks.assign.worker-alpha");
    expect(result.assignmentId).toBeDefined();
    expect(result.taskId).toBe(task.id);
    expect(result.runId).toBe("run-test-101");

    // Verify explicit topic provisioned
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-alpha")).toBe(true);

    // Verify message published
    expect(publisher.published).toHaveLength(1);
    const pubRecord = publisher.published[0];
    expect(pubRecord).toBeDefined();
    if (pubRecord) {
      expect(pubRecord.topic).toBe("aegis.tasks.assign.worker-alpha");
      expect(pubRecord.envelope.data.assignmentId).toBe(result.assignmentId);
      expect(pubRecord.envelope.data.workerId).toBe("worker-alpha");
    }
  });

  it("returns NO_ELIGIBLE_WORKER when no workers match criteria and publishes nothing", async () => {
    const registry = new InMemoryWorkerRegistry();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher,
    });

    const task = createMockTask();
    const result = await dispatcher.dispatch(task);

    expect(result.status).toBe("NO_ELIGIBLE_WORKER");
    expect(result.reason).toBe("NO_REGISTERED_WORKERS");
    expect(publisher.published).toHaveLength(0);
  });

  it("handles topic provisioning failure cleanly", async () => {
    const registry = new InMemoryWorkerRegistry();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();

    const worker = createMockWorker("worker-fail");
    registry.register(worker);

    const failingProvisioner = {
      ensureTopic: () =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: "TOPIC_PROVISION_FAILED" as const,
            message: "Kafka broker admin timeout",
          },
        }),
    };

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher,
      topicProvisioner: failingProvisioner,
    });

    const task = createMockTask();
    const result = await dispatcher.dispatch(task);

    expect(result.status).toBe("DISPATCH_FAILED");
    expect(result.error?.code).toBe("TOPIC_PROVISION_FAILED");
    expect(publisher.published).toHaveLength(0);
  });

  it("handles assignment publisher failure gracefully", async () => {
    const registry = new InMemoryWorkerRegistry();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();
    publisher.shouldFail = true;

    const worker = createMockWorker("worker-pub-fail");
    registry.register(worker);

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher,
    });

    const task = createMockTask();
    const result = await dispatcher.dispatch(task);

    expect(result.status).toBe("DISPATCH_FAILED");
    expect(result.error?.code).toBe("DISPATCH_PUBLISH_FAILED");
  });
});
