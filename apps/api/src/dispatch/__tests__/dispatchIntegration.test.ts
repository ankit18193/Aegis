import type {
  Task,
  WorkerHeartbeatEnvelope,
} from "@aegis/contracts";
import { heartbeatId, runId, taskId, workerId } from "@aegis/types";
import type { Consumer } from "kafkajs";
import { describe, expect, it } from "vitest";

import { WorkerPresenceConsumer } from "../../presence/presenceConsumer.js";
import { InMemoryTopicProvisioner } from "../../presence/topicProvisioner.js";
import { InMemoryWorkerRegistry } from "../../presence/workerRegistry.js";
import { InMemoryTaskAssignmentPublisher } from "../assignmentPublisher.js";
import { TaskDispatcher } from "../dispatcher.js";
import { DeterministicWorkerSelector } from "../workerSelector.js";

describe("Distributed Multi-Worker Dispatch & Routing Integration (Phase 11E — Commit 4)", () => {
  function createHeartbeatEnvelope(
    id: string,
    taskTypes: string[],
    tools: string[],
    maxConcurrency = 2,
    activeTaskCount = 0,
  ): WorkerHeartbeatEnvelope {
    return {
      id: heartbeatId(`hb-evt-${id}`),
      type: "worker_heartbeat",
      source: `aegis.worker.${id}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: workerId(id),
      aggregateType: "Worker",
      correlationId: `corr-${id}`,
      data: {
        heartbeatId: heartbeatId(`hb-${id}`),
        workerId: workerId(id),
        occurredAt: new Date().toISOString(),
        lifecycleState: activeTaskCount > 0 ? "busy" : "ready",
        activeTaskCount,
        maxConcurrentTasks: maxConcurrency,
        capabilities: {
          taskTypes,
          tools,
          maxConcurrency,
        },
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
      description: `Task ${name}`,
      attemptCount: 0,
      dependencies: [],
      input: requiredTools.length > 0 ? { requiredTools } : undefined,
    };
  }

  it("coordinates worker presence, deterministic scheduling, and worker-targeted delivery", async () => {
    // 1. Establish control-plane infrastructure
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
    const topicProvisioner = new InMemoryTopicProvisioner();
    const selector = new DeterministicWorkerSelector();
    const assignmentPublisher = new InMemoryTaskAssignmentPublisher();

    // 2. Control-plane presence consumer
    const presenceConsumer = new WorkerPresenceConsumer({
      consumer: {
        connect: () => Promise.resolve(),
        subscribe: () => Promise.resolve(),
        run: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
      } as unknown as Consumer,
      registry,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    // 3. Register Worker 1 (NLP/LLM worker)
    const worker1Envelope = createHeartbeatEnvelope(
      "worker-nlp",
      ["llm", "summarize"],
      ["web_search"],
      2,
    );
    await presenceConsumer.handleMessage(
      Buffer.from(JSON.stringify(worker1Envelope)),
    );

    // 4. Register Worker 2 (Code execution worker)
    const worker2Envelope = createHeartbeatEnvelope(
      "worker-code",
      ["bash", "python"],
      ["git", "fs"],
      2,
    );
    await presenceConsumer.handleMessage(
      Buffer.from(JSON.stringify(worker2Envelope)),
    );

    // Verify both workers registered in control-plane registry as HEALTHY
    expect(registry.get(workerId("worker-nlp"))?.presenceState).toBe("HEALTHY");
    expect(registry.get(workerId("worker-code"))?.presenceState).toBe("HEALTHY");

    // Verify both dedicated assignment topics were provisioned
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-nlp")).toBe(true);
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-code")).toBe(true);

    // 5. Initialize TaskDispatcher in control plane
    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher: assignmentPublisher,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    // 6. Dispatch Task A (requires 'llm' and 'web_search') -> should route strictly to worker-nlp
    const taskA = createMockTask("task-A", "llm", ["web_search"]);
    const resultA = await dispatcher.dispatch(taskA, { runId: runId("run-100") });

    expect(resultA.status).toBe("ASSIGNED");
    expect(resultA.workerId).toBe("worker-nlp");
    expect(resultA.targetTopic).toBe("aegis.tasks.assign.worker-nlp");

    // 7. Dispatch Task B (requires 'python' and 'git') -> should route strictly to worker-code
    const taskB = createMockTask("task-B", "python", ["git"]);
    const resultB = await dispatcher.dispatch(taskB, { runId: runId("run-100") });

    expect(resultB.status).toBe("ASSIGNED");
    expect(resultB.workerId).toBe("worker-code");
    expect(resultB.targetTopic).toBe("aegis.tasks.assign.worker-code");

    // 8. Dispatch Task C (requires 'bash') -> should route strictly to worker-code
    const taskC = createMockTask("task-C", "bash");
    const resultC = await dispatcher.dispatch(taskC, { runId: runId("run-100") });

    expect(resultC.status).toBe("ASSIGNED");
    expect(resultC.workerId).toBe("worker-code");
    expect(resultC.targetTopic).toBe("aegis.tasks.assign.worker-code");

    // 9. Inspect published messages to verify worker-specific topic isolation (Lock 8)
    const nlpMessages = assignmentPublisher.published.filter(
      (p) => p.topic === "aegis.tasks.assign.worker-nlp",
    );
    const codeMessages = assignmentPublisher.published.filter(
      (p) => p.topic === "aegis.tasks.assign.worker-code",
    );

    // Worker 1 received only Task A
    expect(nlpMessages).toHaveLength(1);
    const firstNlpMsg = nlpMessages[0];
    expect(firstNlpMsg).toBeDefined();
    if (firstNlpMsg) {
      expect(firstNlpMsg.envelope.data.taskId).toBe("task-A");
      expect(firstNlpMsg.envelope.data.workerId).toBe("worker-nlp");
    }

    // Worker 2 received Task B and Task C
    expect(codeMessages).toHaveLength(2);
    const codeTaskIds = codeMessages.map((m) => m.envelope.data.taskId);
    expect(codeTaskIds).toEqual(["task-B", "task-C"]);

    // Neither worker saw the other's tasks (zero partition contention)
    expect(nlpMessages.some((m) => m.envelope.data.taskId === "task-B")).toBe(false);
    expect(codeMessages.some((m) => m.envelope.data.taskId === "task-A")).toBe(false);
  });

  it("handles dynamic load, capacity exhaustion, and recovery in multi-worker environment", async () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 5000 });
    const topicProvisioner = new InMemoryTopicProvisioner();
    const selector = new DeterministicWorkerSelector();
    const publisher = new InMemoryTaskAssignmentPublisher();

    const dispatcher = new TaskDispatcher({
      registry,
      selector,
      publisher,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    // Two identical general workers: worker-1 and worker-2 (maxConcurrency = 1)
    const hb1 = createHeartbeatEnvelope("worker-1", ["*"], [], 1, 0);
    const hb2 = createHeartbeatEnvelope("worker-2", ["*"], [], 1, 0);

    registry.updateHeartbeat(hb1.data);
    registry.updateHeartbeat(hb2.data);

    // Dispatch 1: Both available with 0 load -> tie break selects worker-1 (Lock 7)
    const t1 = createMockTask("task-1", "general");
    const r1 = await dispatcher.dispatch(t1);
    expect(r1.status).toBe("ASSIGNED");
    expect(r1.workerId).toBe("worker-1");

    // Simulate worker-1 reporting activeTaskCount = 1 (at capacity)
    const hb1Busy = createHeartbeatEnvelope("worker-1", ["*"], [], 1, 1);
    registry.updateHeartbeat(hb1Busy.data);

    // Dispatch 2: worker-1 is full, worker-2 has 0 load -> selects worker-2
    const t2 = createMockTask("task-2", "general");
    const r2 = await dispatcher.dispatch(t2);
    expect(r2.status).toBe("ASSIGNED");
    expect(r2.workerId).toBe("worker-2");

    // Simulate worker-2 reporting activeTaskCount = 1 (both at capacity)
    const hb2Busy = createHeartbeatEnvelope("worker-2", ["*"], [], 1, 1);
    registry.updateHeartbeat(hb2Busy.data);

    // Dispatch 3: Both at capacity -> returns CAPACITY_EXHAUSTED
    const t3 = createMockTask("task-3", "general");
    const r3 = await dispatcher.dispatch(t3);
    expect(r3.status).toBe("NO_ELIGIBLE_WORKER");
    expect(r3.reason).toBe("CAPACITY_EXHAUSTED");

    // Simulate worker-1 completing task -> activeTaskCount = 0
    const hb1Free = createHeartbeatEnvelope("worker-1", ["*"], [], 1, 0);
    registry.updateHeartbeat(hb1Free.data);

    // Dispatch 4: worker-1 is available again -> dispatch succeeds
    const t4 = createMockTask("task-4", "general");
    const r4 = await dispatcher.dispatch(t4);
    expect(r4.status).toBe("ASSIGNED");
    expect(r4.workerId).toBe("worker-1");
  });
});
