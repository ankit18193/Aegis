import { runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InProcessExecutionDispatcher } from "./executionDispatcher.js";

describe("InProcessExecutionDispatcher", () => {
  it("dispatches execution and tracks active running state", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const testId = runId("run-disp-001");

    let executed = false;
    dispatcher.dispatch(testId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      executed = true;
    });

    expect(dispatcher.getActiveRunIds()).toContain(testId);
    expect(dispatcher.isRunning(testId)).toBe(true);

    await dispatcher.awaitCompletion(testId);

    expect(executed).toBe(true);
    expect(dispatcher.isRunning(testId)).toBe(false);
    expect(dispatcher.getActiveRunIds()).not.toContain(testId);
  });

  it("signals cancellation to active execution via AbortSignal", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const testId = runId("run-disp-002");

    let wasAborted = false;
    let abortReason: string | undefined;

    dispatcher.dispatch(testId, async (signal) => {
      if (signal.aborted) {
        wasAborted = true;
        abortReason = typeof signal.reason === "string" ? signal.reason : undefined;
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          wasAborted = true;
          abortReason = typeof signal.reason === "string" ? signal.reason : undefined;
          resolve();
        });
      });
    });

    const cancelled = dispatcher.cancel(testId, "Manual stop from test");
    expect(cancelled).toBe(true);

    await dispatcher.awaitCompletion(testId);
    expect(wasAborted).toBe(true);
    expect(abortReason).toBe("Manual stop from test");
  });

  it("returns false when cancelling non-existent run ID", () => {
    const dispatcher = new InProcessExecutionDispatcher();
    expect(dispatcher.cancel(runId("run-unknown"))).toBe(false);
  });

  it("handles execution failures without unhandled rejections", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const testId = runId("run-disp-err");

    dispatcher.dispatch(testId, async () => {
      await Promise.resolve();
      throw new Error("Simulated dispatcher crash");
    });

    await dispatcher.awaitCompletion(testId);
    expect(dispatcher.isRunning(testId)).toBe(false);
  });

  it("times out if execution takes longer than timeoutMs", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const testId = runId("run-disp-timeout");

    dispatcher.dispatch(testId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    await expect(dispatcher.awaitCompletion(testId, 50)).rejects.toThrow("Timed out waiting for run");
    dispatcher.cancel(testId);
  });
});
