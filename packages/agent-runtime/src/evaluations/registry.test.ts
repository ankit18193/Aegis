import type { IEvaluator } from "@aegis/contracts";
import { evaluatorId, ok } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import {
  compareSemver,
  EvaluatorRegistry,
  EvaluatorRegistryError,
  parseSemver,
} from "./registry.js";

function createMockEvaluator(id: string, version: string): IEvaluator {
  return {
    id: evaluatorId(id),
    version,
    kind: "deterministic",
    metricType: "binary",
    evaluate: () =>
      Promise.resolve(
        ok({
          verdict: "pass",
          score: 1.0,
          reason: "Mock passed",
          assertions: [],
        }),
      ),
  };
}

describe("Evaluator Registry & Semantic Versioning (Phase 14B — Milestone 1)", () => {
  describe("parseSemver and compareSemver", () => {
    it("parses valid semver strings", () => {
      const parsed = parseSemver("1.2.3");
      expect(parsed).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        raw: "1.2.3",
      });
    });

    it("parses semver with prerelease tags", () => {
      const parsed = parseSemver("2.0.0-beta.1");
      expect(parsed).toEqual({
        major: 2,
        minor: 0,
        patch: 0,
        raw: "2.0.0-beta.1",
      });
    });

    it("returns null for non-semver strings", () => {
      expect(parseSemver("v1")).toBeNull();
      expect(parseSemver("latest")).toBeNull();
      expect(parseSemver("")).toBeNull();
    });

    it("orders semver versions monotonically", () => {
      const v1 = parseSemver("1.0.0");
      const v2 = parseSemver("1.1.0");
      const v3 = parseSemver("2.0.0");

      expect(v1).toBeDefined();
      expect(v2).toBeDefined();
      expect(v3).toBeDefined();
      if (!v1 || !v2 || !v3) {
        throw new Error("Parsed semvers must be defined");
      }

      expect(compareSemver(v1, v2)).toBeLessThan(0);
      expect(compareSemver(v2, v1)).toBeGreaterThan(0);
      expect(compareSemver(v2, v3)).toBeLessThan(0);
      expect(compareSemver(v1, v1)).toBe(0);
    });
  });

  describe("EvaluatorRegistry Operations", () => {
    let registry: EvaluatorRegistry;

    beforeEach(() => {
      registry = new EvaluatorRegistry();
    });

    it("registers and resolves an evaluator by exact id and version", () => {
      const eval1 = createMockEvaluator("exact_match", "1.0.0");
      registry.register(eval1);

      expect(registry.has(evaluatorId("exact_match"), "1.0.0")).toBe(true);
      const resolved = registry.resolve(evaluatorId("exact_match"), "1.0.0");
      expect(resolved).toBe(eval1);
    });

    it("rejects duplicate registration of identical id and version", () => {
      const eval1 = createMockEvaluator("exact_match", "1.0.0");
      const duplicate = createMockEvaluator("exact_match", "1.0.0");

      registry.register(eval1);

      expect(() => registry.register(duplicate)).toThrow(EvaluatorRegistryError);
      expect(() => registry.register(duplicate)).toThrowError(
        /Evaluator 'exact_match' version '1.0.0' is already registered/,
      );
    });

    it("supports registering multiple versions of the same evaluator", () => {
      const v1 = createMockEvaluator("exact_match", "1.0.0");
      const v2 = createMockEvaluator("exact_match", "1.1.0");
      const v3 = createMockEvaluator("exact_match", "2.0.0");

      registry.register(v1);
      registry.register(v2);
      registry.register(v3);

      expect(registry.resolve(evaluatorId("exact_match"), "1.0.0")).toBe(v1);
      expect(registry.resolve(evaluatorId("exact_match"), "1.1.0")).toBe(v2);
      expect(registry.resolve(evaluatorId("exact_match"), "2.0.0")).toBe(v3);
    });

    it("resolves the highest semantic version when version is omitted", () => {
      const v1 = createMockEvaluator("tool_call", "1.0.0");
      const v3 = createMockEvaluator("tool_call", "2.0.0");
      const v2 = createMockEvaluator("tool_call", "1.9.0");

      registry.register(v1);
      registry.register(v3);
      registry.register(v2);

      const resolved = registry.resolve(evaluatorId("tool_call"));
      expect(resolved).toBe(v3);
      expect(resolved?.version).toBe("2.0.0");
    });

    it("returns undefined when resolving an unregistered evaluator or version", () => {
      const eval1 = createMockEvaluator("exact_match", "1.0.0");
      registry.register(eval1);

      expect(registry.resolve(evaluatorId("unknown"))).toBeUndefined();
      expect(registry.resolve(evaluatorId("exact_match"), "9.9.9")).toBeUndefined();
      expect(registry.has(evaluatorId("unknown"))).toBe(false);
      expect(registry.has(evaluatorId("exact_match"), "9.9.9")).toBe(false);
    });

    it("lists all registered evaluators and clears them", () => {
      const e1 = createMockEvaluator("eval_a", "1.0.0");
      const e2 = createMockEvaluator("eval_b", "1.0.0");

      registry.register(e1);
      registry.register(e2);

      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all).toContain(e1);
      expect(all).toContain(e2);

      registry.clear();
      expect(registry.list()).toHaveLength(0);
      expect(registry.has(evaluatorId("eval_a"))).toBe(false);
    });

    it("rejects invalid evaluator objects with missing id or version", () => {
      // @ts-expect-error Testing runtime boundary check
      expect(() => registry.register(null)).toThrow(EvaluatorRegistryError);
      // @ts-expect-error Testing runtime boundary check
      expect(() => registry.register({ id: "" })).toThrow(EvaluatorRegistryError);
      // @ts-expect-error Testing runtime boundary check
      expect(() => registry.register({ id: evaluatorId("valid"), version: "" })).toThrow(
        EvaluatorRegistryError,
      );
    });
  });
});
