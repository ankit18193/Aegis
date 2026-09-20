import { runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { DeterministicModelProvider } from "./model.js";
import { DeterministicPlanner, ModelPlanner } from "./planner.js";
import { AgentState } from "./state.js";

describe("Planner Abstractions", () => {
  const testState = AgentState.init(runId("run-plan-001"), "Analyze database index contention");

  describe("DeterministicPlanner", () => {
    it("yields decisions in scripted sequence", async () => {
      const planner = new DeterministicPlanner([
        { type: "execute", action: { name: "echo", payload: { step: 1 } } },
        { type: "complete", summary: "Analysis complete" },
      ]);

      const step1 = await planner.plan(testState);
      expect(step1.ok).toBe(true);
      if (step1.ok) {
        expect(step1.value.type).toBe("execute");
        if (step1.value.type === "execute") {
          expect(step1.value.action.name).toBe("echo");
        }
      }

      const step2 = await planner.plan(testState);
      expect(step2.ok).toBe(true);
      if (step2.ok) {
        expect(step2.value.type).toBe("complete");
      }
    });

    it("returns error when planned decisions are exhausted", async () => {
      const planner = new DeterministicPlanner([
        { type: "complete", summary: "Single step" },
      ]);

      await planner.plan(testState);
      const exhausted = await planner.plan(testState);

      expect(exhausted.ok).toBe(false);
      if (!exhausted.ok) {
        expect(exhausted.error.code).toBe("PLANNER_ERROR");
        expect(exhausted.error.message).toContain("exhausted all 1 planned decisions");
      }
    });

    it("supports custom dynamic planner callbacks", async () => {
      const planner = new DeterministicPlanner((state) => {
        if (state.iteration === 0) {
          return {
            ok: true,
            value: { type: "execute", action: { name: "noop", payload: {} } },
          };
        }
        return {
          ok: true,
          value: { type: "complete", summary: "Finished in turn 1" },
        };
      });

      const first = await planner.plan(testState);
      expect(first.ok && first.value.type === "execute").toBe(true);

      testState.incrementIteration();
      const second = await planner.plan(testState);
      expect(second.ok && second.value.type === "complete").toBe(true);
    });
  });

  describe("ModelPlanner", () => {
    it("generates and parses valid 'execute' ActionDecision from model response", async () => {
      const model = new DeterministicModelProvider([
        JSON.stringify({
          type: "execute",
          action: { name: "calculate", payload: { expression: "2 + 2" } },
          rationale: "Need to compute memory boundary",
        }),
      ]);
      const planner = new ModelPlanner(model);

      const decision = await planner.plan(testState);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.value.type).toBe("execute");
        if (decision.value.type === "execute") {
          expect(decision.value.action.name).toBe("calculate");
          expect(decision.value.rationale).toBe("Need to compute memory boundary");
        }
      }
    });

    it("generates and parses valid 'complete' ActionDecision", async () => {
      const model = new DeterministicModelProvider([
        JSON.stringify({
          type: "complete",
          summary: "Identified unindexed column",
          output: "Recommend index on runs(status)",
        }),
      ]);
      const planner = new ModelPlanner(model);

      const decision = await planner.plan(testState);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.value.type).toBe("complete");
        if (decision.value.type === "complete") {
          expect(decision.value.summary).toBe("Identified unindexed column");
          expect(decision.value.output).toBe("Recommend index on runs(status)");
        }
      }
    });

    it("generates and parses valid 'fail' ActionDecision", async () => {
      const model = new DeterministicModelProvider([
        JSON.stringify({
          type: "fail",
          reason: "Target cluster is unreachable",
        }),
      ]);
      const planner = new ModelPlanner(model);

      const decision = await planner.plan(testState);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.value.type).toBe("fail");
        if (decision.value.type === "fail") {
          expect(decision.value.reason).toBe("Target cluster is unreachable");
        }
      }
    });

    it("handles unparseable JSON from model as PARSE_ERROR", async () => {
      const model = new DeterministicModelProvider(["Not valid JSON at all"]);
      const planner = new ModelPlanner(model);

      const decision = await planner.plan(testState);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error.code).toBe("PARSE_ERROR");
        expect(decision.error.message).toContain("Failed to parse model response");
      }
    });

    it("handles invalid schema shape as PARSE_ERROR", async () => {
      const model = new DeterministicModelProvider([
        JSON.stringify({ type: "execute" }), // missing action object
      ]);
      const planner = new ModelPlanner(model);

      const decision = await planner.plan(testState);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.error.code).toBe("PARSE_ERROR");
      }
    });
  });
});
