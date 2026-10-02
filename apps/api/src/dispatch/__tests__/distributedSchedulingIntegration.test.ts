import type {
  Task,
  TaskAssignmentEnvelope,
  TaskExecutionResult,
  WorkerHeartbeat,
} from "@aegis/contracts";
import {
  extractTaskRequirements,
  resolveWorkerAssignmentTopic,
} from "@aegis/contracts";
import {
  heartbeatId,
  runId,
  taskId,
  workerId,
} from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InMemoryTopicProvisioner } from "../../presence/topicProvisioner.js";
import { InMemoryWorkerRegistry } from "../../presence/workerRegistry.js";
import { InMemoryTaskAssignmentPublisher } from "../assignmentPublisher.js";
import { TaskDispatcher } from "../dispatcher.js";
import { DeterministicWorkerSelector } from "../workerSelector.js";

describe("Distributed Scheduling & End-to-End Task Dispatch Pipeline (Phase 11E — Commit 5)", () => {
  function createHeartbeat(
    id: string,
    taskTypes: string[],
    tools: string[],
    maxConcurrentTasks = 2,
    activeTaskCount = 0,
    timestamp = new Date().toISOString(),
  ): WorkerHeartbeat {
    return {
      heartbeatId: heartbeatId(`hb-${id}`),
      workerId: workerId(id),
      occurredAt: timestamp,
      lifecycleState: activeTaskCount > 0 ? "busy" : "ready",
      activeTaskCount,
      maxConcurrentTasks,
      capabilities: {
        taskTypes,
        tools,
        maxConcurrency: maxConcurrentTasks,
      },
    };
  }

  function createMockTask(
    id: string,
    name: string,
    requiredTools: string[] = [],
  ): Task {
    return {
      id: taskId(id),
      name,
      status: "pending",
      description: `Description for ${name}`,
      attemptCount: 0,
      dependencies: [],
      input: requiredTools.length > 0 ? { requiredTools } : undefined,
    };
  }

  it("executes the full dispatch, routing, and simulated worker execution lifecycle", async () => {
    // Setup control plane
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 15000 });
    const topicProvisioner = new InMemoryTopicProvisioner();
    const selector = new DeterministicWorkerSelector();
    const assignmentPublisher = new InMemoryTaskAssignmentPublisher();

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher: assignmentPublisher,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    // Worker A: Analytics specialist
    registry.updateHeartbeat(
      createHeartbeat("worker-analytics", ["analytics", "metrics"], ["sql", "plot"], 3),
    );

    // Worker B: General worker
    registry.updateHeartbeat(
      createHeartbeat("worker-general", ["*"], [], 2),
    );

    // Dispatch Task 1: Analytics
    const task1 = createMockTask("task-101", "analytics", ["sql"]);
    const dispatch1 = await dispatcher.dispatch(task1, { runId: runId("run-alpha") });

    expect(dispatch1.status).toBe("ASSIGNED");
    expect(dispatch1.workerId).toBe("worker-analytics");
    expect(dispatch1.targetTopic).toBe("aegis.tasks.assign.worker-analytics");
    expect(dispatch1.assignmentId).toBeDefined();

    // Dispatch Task 2: Arbitrary task (should match wildcard on worker-general)
    const task2 = createMockTask("task-102", "arbitrary_step");
    const dispatch2 = await dispatcher.dispatch(task2, { runId: runId("run-alpha") });

    expect(dispatch2.status).toBe("ASSIGNED");
    expect(dispatch2.workerId).toBe("worker-general");
    expect(dispatch2.targetTopic).toBe("aegis.tasks.assign.worker-general");

    // Verify both topics explicitly provisioned (zero auto-creation reliance)
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-analytics")).toBe(true);
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-general")).toBe(true);
    expect(topicProvisioner.hasTopic("aegis.tasks.assign")).toBe(false); // Zero shared unrouted topic!

    // Verify published envelopes
    expect(assignmentPublisher.published).toHaveLength(2);

    // Simulate Worker Analytics consuming from aegis.tasks.assign.worker-analytics
    const analyticsMessages = assignmentPublisher.published.filter(
      (p) => p.topic === "aegis.tasks.assign.worker-analytics",
    );
    expect(analyticsMessages).toHaveLength(1);
    const analyticsMsg = analyticsMessages[0];
    expect(analyticsMsg).toBeDefined();
    if (analyticsMsg) {
      const envelope: TaskAssignmentEnvelope = analyticsMsg.envelope;
      expect(envelope.data.workerId).toBe("worker-analytics");
      expect(envelope.data.task.id).toBe("task-101");

      // Verify simulated worker execution outcome
      const simulatedResult: TaskExecutionResult = {
        taskId: envelope.data.task.id,
        assignmentId: envelope.data.assignmentId,
        runId: envelope.data.runId,
        workerId: workerId("worker-analytics"),
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: "Analytics calculation complete",
      };
      expect(simulatedResult.status).toBe("SUCCEEDED");
      expect(simulatedResult.taskId).toBe(envelope.data.task.id);
    }
  });

  it("strictly enforces worker-targeted routing and eliminates shared topic partition cross-talk", () => {
    const baseTopic = "aegis.tasks.assign";
    const w1 = workerId("worker-1");
    const w2 = workerId("worker-2");

    const topic1 = resolveWorkerAssignmentTopic(baseTopic, w1);
    const topic2 = resolveWorkerAssignmentTopic(baseTopic, w2);

    expect(topic1).toBe("aegis.tasks.assign.worker-1");
    expect(topic2).toBe("aegis.tasks.assign.worker-2");
    expect(topic1).not.toBe(topic2);

    // Verify missing workerId strictly throws (Lock 8)
    expect(() => resolveWorkerAssignmentTopic(baseTopic, workerId(""))).toThrow();
  });

  it("handles liveness timeouts and recovery in control plane", async () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 5000 });
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();
    const dispatcher = new TaskDispatcher({ registry, selector, publisher });

    const initialTime = new Date("2026-10-01T12:00:00.000Z");
    const hb = createHeartbeat("w-resilient", ["*"], [], 2, 0, initialTime.toISOString());
    registry.updateHeartbeat(hb);

    // 1. Worker is HEALTHY -> Dispatch succeeds
    const t1 = createMockTask("t-1", "job");
    const res1 = await dispatcher.dispatch(t1);
    expect(res1.status).toBe("ASSIGNED");

    // 2. Advance time 10 seconds without heartbeats -> transitions to STALE
    const staleTime = new Date("2026-10-01T12:00:10.000Z");
    registry.markStale(staleTime);
    expect(registry.get(workerId("w-resilient"))?.presenceState).toBe("STALE");

    // 3. Attempt dispatch while STALE -> fails with NO_HEALTHY_WORKERS
    const t2 = createMockTask("t-2", "job");
    const res2 = await dispatcher.dispatch(t2);
    expect(res2.status).toBe("NO_ELIGIBLE_WORKER");
    expect(res2.reason).toBe("NO_HEALTHY_WORKERS");

    // 4. Worker sends new heartbeat -> recovers to HEALTHY
    const recoverTime = new Date("2026-10-01T12:00:11.000Z");
    const recoverHb = createHeartbeat("w-resilient", ["*"], [], 2, 0, recoverTime.toISOString());
    registry.updateHeartbeat(recoverHb);
    expect(registry.get(workerId("w-resilient"))?.presenceState).toBe("HEALTHY");

    // 5. Dispatch succeeds again
    const res3 = await dispatcher.dispatch(t2);
    expect(res3.status).toBe("ASSIGNED");
    expect(res3.workerId).toBe("w-resilient");
  });

  it("demonstrates deterministic tie-breaking across multiple identical workers (Lock 7)", async () => {
    const registry = new InMemoryWorkerRegistry();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();
    const dispatcher = new TaskDispatcher({ registry, selector, publisher });

    // Three identical workers with 0 active load
    registry.updateHeartbeat(createHeartbeat("worker-gamma", ["*"], [], 2, 0));
    registry.updateHeartbeat(createHeartbeat("worker-alpha", ["*"], [], 2, 0));
    registry.updateHeartbeat(createHeartbeat("worker-beta", ["*"], [], 2, 0));

    // First dispatch chooses worker-alpha (lexicographical first tie-break)
    const task = createMockTask("t-tie", "task");
    const res = await dispatcher.dispatch(task);
    expect(res.status).toBe("ASSIGNED");
    expect(res.workerId).toBe("worker-alpha");
  });

  it("extracts task requirements accurately from tasks with tool requirements", () => {
    const taskWithTools = createMockTask("t-tools", "compile", ["clang", "make"]);
    const reqs = extractTaskRequirements(taskWithTools);
    expect(reqs.taskType).toBe("compile");
    expect(reqs.requiredTools).toEqual(["clang", "make"]);
  });
});
