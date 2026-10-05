import type { Run, Task } from "@aegis/contracts";
import { runId, taskId, workerId, workflowId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRunRepository } from "../../repositories/inMemoryRunRepository.js";
import { TaskLeaseMonitor } from "../leaseMonitor.js";

function createRunningTestRun(rId: string, tId: string, wId: string, initialVersion = 1): Run {
  const t: Task = {
    id: taskId(tId),
    name: "Execution Unit 1",
    status: "running",
    description: "Lease monitor test task",
    attemptCount: 1,
    worker: workerId(wId),
    workerId: workerId(wId),
    version: initialVersion,
    startedAt: new Date().toISOString(),
  };

  return {
    id: runId(rId),
    goal: "Test lease monitor",
    status: "running",
    progress: 25,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Lease Pipeline",
      tasks: [t],
    },
    tasks: [t],
  };
}

describe("TaskLeaseMonitor (Phase 12B — Commit 4)", () => {
  let repo: InMemoryRunRepository;

  beforeEach(() => {
    repo = new InMemoryRunRepository(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("manages background timer lifecycle cleanly", () => {
    const monitor = new TaskLeaseMonitor({
      repository: repo,
      sweepIntervalMs: 2000,
    });

    expect(monitor.isRunning).toBe(false);
    expect(monitor.sweepsCount).toBe(0);

    monitor.start();
    expect(monitor.isRunning).toBe(true);

    // Calling start again is idempotent
    monitor.start();
    expect(monitor.isRunning).toBe(true);

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  it("detects expired task leases and marks them atomically", async () => {
    const rId = "run-monitor-1";
    const tId = "task-monitor-1";
    const wId = "worker-alpha";
    const testRun = createRunningTestRun(rId, tId, wId, 1);
    await repo.save(testRun);

    // Acquire initial 10s lease
    const acqRes = await repo.acquireTaskLease(taskId(tId), workerId(wId), 10000, 1);
    expect(acqRes.ok).toBe(true);

    const onExpiredSpy = vi.fn();
    const monitor = new TaskLeaseMonitor({
      repository: repo,
      onLeaseExpired: onExpiredSpy,
    });

    // 1. Sweep immediately: lease is valid for 10s -> 0 expired
    const immediateRes = await monitor.sweepOnce(new Date());
    expect(immediateRes.checkedCandidates).toBe(0);
    expect(immediateRes.expiredMarked).toBe(0);
    expect(onExpiredSpy).not.toHaveBeenCalled();

    // 2. Advance time by 15s (beyond leaseUntil)
    const futureTime = new Date(Date.now() + 15000);
    const expiredRes = await monitor.sweepOnce(futureTime);

    expect(expiredRes.checkedCandidates).toBe(1);
    expect(expiredRes.expiredMarked).toBe(1);
    expect(expiredRes.conflictsSkipped).toBe(0);
    expect(monitor.expiredCount).toBe(1);
    expect(onExpiredSpy).toHaveBeenCalledTimes(1);

    // 3. Verify INVARIANT: Task remains running with worker preserved!
    const runAfter = await repo.findById(runId(rId));
    const taskAfter = runAfter?.tasks.find((t) => t.id === taskId(tId));
    expect(taskAfter).toBeDefined();
    expect(taskAfter?.status).toBe("running"); // STRICT: NOT failed
    expect(taskAfter?.workerId).toBe(workerId(wId)); // STRICT: worker identity preserved
    expect(taskAfter?.leaseExpiredAt).toBe(futureTime.toISOString());
    expect(taskAfter?.version).toBe(3); // 1 (init) -> 2 (acquire) -> 3 (mark expired)

    // 4. Verify audit event was recorded to timeline
    const events = await repo.findEvents(runId(rId));
    const expEvent = events.find((e) => e.type === "task_lease_expired");
    expect(expEvent).toBeDefined();
    expect(expEvent?.severity).toBe("warn");
    expect(expEvent?.taskId).toBe(taskId(tId));
    expect(expEvent?.worker).toBe(workerId(wId));
  });

  it("handles concurrent conflict gracefully when task version changes before mark", async () => {
    const rId = "run-monitor-conflict";
    const tId = "task-monitor-conflict";
    const wId = "worker-beta";
    const testRun = createRunningTestRun(rId, tId, wId, 1);
    await repo.save(testRun);

    // Acquire lease
    await repo.acquireTaskLease(taskId(tId), workerId(wId), 5000, 1);

    // Spy on markTaskLeaseExpired to simulate a version conflict (returns false)
    const originalMark = repo.markTaskLeaseExpired.bind(repo);
    const markSpy = vi.spyOn(repo, "markTaskLeaseExpired").mockImplementation(async (id, expectedVersion, expiredAt) => {
      // Intentionally pass an incorrect expectedVersion to trigger optimistic lock conflict
      return originalMark(id, expectedVersion + 999, expiredAt);
    });

    const monitor = new TaskLeaseMonitor({
      repository: repo,
    });

    const futureTime = new Date(Date.now() + 10000);
    const result = await monitor.sweepOnce(futureTime);

    expect(result.checkedCandidates).toBe(1);
    expect(result.expiredMarked).toBe(0);
    expect(result.conflictsSkipped).toBe(1);

    markSpy.mockRestore();
  });

  it("triggers periodic sweeps when started with fake timers", async () => {
    vi.useFakeTimers();

    const monitor = new TaskLeaseMonitor({
      repository: repo,
      sweepIntervalMs: 1000,
    });

    const sweepSpy = vi.spyOn(monitor, "sweepOnce").mockResolvedValue({
      checkedCandidates: 0,
      expiredMarked: 0,
      conflictsSkipped: 0,
    });

    monitor.start();
    expect(monitor.isRunning).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sweepSpy).toHaveBeenCalledTimes(3);

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });
});
