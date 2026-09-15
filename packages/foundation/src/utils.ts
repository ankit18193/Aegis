/**
 * Utility: generates a semantic version string.
 *
 * @param major - Major version number.
 * @param minor - Minor version number.
 * @param patch - Patch version number.
 * @param prerelease - Optional prerelease identifier.
 * @returns Formatted semver string e.g. "1.2.3" or "1.2.3-alpha.1".
 */
export function semver(major: number, minor: number, patch: number, prerelease?: string): string {
  const base = `${major.toString()}.${minor.toString()}.${patch.toString()}`;
  return prerelease !== undefined ? `${base}-${prerelease}` : base;
}

/**
 * Checks if a value is a non-null, non-undefined record (plain object).
 *
 * @param value - Any value.
 * @returns True if value is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asserts that a condition is true, throwing an Error with the given message if not.
 * This is a type-narrowing assertion suitable for invariant checks.
 *
 * @param condition - The condition to assert.
 * @param message - Error message thrown when the assertion fails.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violation: ${message}`);
  }
}

/**
 * Type-safe exhaustive check for discriminated unions.
 * Throw this in the default branch of a switch to ensure all cases are handled.
 *
 * @param _value - The value that should be `never`.
 * @param message - Optional context message.
 */
export function assertNever(_value: never, message = "Unexpected value"): never {
  throw new Error(message);
}
