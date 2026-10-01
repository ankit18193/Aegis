import { describe, expect, it } from "vitest";

import { ConcurrencyGate } from "../concurrencyGate.js";

describe("ConcurrencyGate", () => {
  it("allows executions up to maxConcurrent limit immediately", async () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.maxConcurrency).toBe(2);
    expect(gate.activeCount).toBe(0);
    expect(gate.waitingCount).toBe(0);

    let running1 = false;
    let running2 = false;

    const p1 = gate.runBounded(async () => {
      running1 = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const p2 = gate.runBounded(async () => {
      running2 = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(gate.activeCount).toBe(2);
    expect(gate.waitingCount).toBe(0);

    await Promise.all([p1, p2]);
    expect(running1).toBe(true);
    expect(running2).toBe(true);
    expect(gate.activeCount).toBe(0);
  });

  it("queues executions that exceed concurrency limit until capacity is freed", async () => {
    const gate = new ConcurrencyGate(1);
    const order: number[] = [];

    let resolve1!: () => void;
    const task1Promise = new Promise<void>((res) => {
      resolve1 = res;
    });

    const exec1 = gate.runBounded(async () => {
      order.push(1);
      await task1Promise;
    });

    const exec2 = gate.runBounded(async () => {
      await Promise.resolve();
      order.push(2);
    });

    // Give microtasks a turn
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(gate.activeCount).toBe(1);
    expect(gate.waitingCount).toBe(1);
    expect(order).toEqual([1]);

    // Release task1
    resolve1();
    await exec1;
    await exec2;

    expect(order).toEqual([1, 2]);
    expect(gate.activeCount).toBe(0);
    expect(gate.waitingCount).toBe(0);
  });

  it("releases permit even if bounded function throws", async () => {
    const gate = new ConcurrencyGate(1);

    await expect(
      gate.runBounded(async () => {
        await Promise.resolve();
        throw new Error("Task execution failure");
      }),
    ).rejects.toThrow("Task execution failure");

    expect(gate.activeCount).toBe(0);

    // Subsequent execution should succeed without blocking
    const result = await gate.runBounded(async () => {
      await Promise.resolve();
      return "success";
    });
    expect(result).toBe("success");
    expect(gate.activeCount).toBe(0);
  });
});
