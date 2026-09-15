import { describe, expect, it } from "vitest";

import { semver, isRecord, invariant, assertNever } from "./utils.js";

describe("semver", () => {
  it("formats a standard version string", () => {
    expect(semver(1, 2, 3)).toBe("1.2.3");
  });

  it("formats a prerelease version string", () => {
    expect(semver(0, 1, 0, "alpha.1")).toBe("0.1.0-alpha.1");
  });

  it("handles 0.0.0 correctly", () => {
    expect(semver(0, 0, 0)).toBe("0.0.0");
  });
});

describe("isRecord", () => {
  it("returns true for a plain object", () => {
    expect(isRecord({ key: "value" })).toBe(true);
  });

  it("returns false for an array", () => {
    expect(isRecord([])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isRecord("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isRecord(42)).toBe(false);
  });
});

describe("invariant", () => {
  it("does not throw when condition is true", () => {
    expect(() => {
      invariant(true, "should not throw");
    }).not.toThrow();
  });

  it("throws when condition is false", () => {
    expect(() => {
      invariant(false, "condition failed");
    }).toThrow("Invariant violation: condition failed");
  });

  it("throws when condition is null", () => {
    expect(() => {
      invariant(null, "null is falsy");
    }).toThrow();
  });
});

describe("assertNever", () => {
  it("throws an error", () => {
    expect(() => {
      assertNever("unexpected" as never);
    }).toThrow();
  });
});
