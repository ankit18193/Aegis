import type { IEvaluator } from "@aegis/contracts";
import type { EvaluatorId } from "@aegis/types";

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Versioning Utilities
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/**
 * Parses a standard semantic version string (e.g., "1.0.0", "2.1.3").
 */
export function parseSemver(version: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: version.trim(),
  };
}

/**
 * Compares two parsed semantic versions.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry Errors
// ─────────────────────────────────────────────────────────────────────────────

export type EvaluatorRegistryErrorCode =
  | "DUPLICATE_EVALUATOR"
  | "INVALID_VERSION"
  | "INVALID_EVALUATOR";

export class EvaluatorRegistryError extends Error {
  readonly code: EvaluatorRegistryErrorCode;

  constructor(code: EvaluatorRegistryErrorCode, message: string) {
    super(message);
    this.name = "EvaluatorRegistryError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Registry Interface & Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface IEvaluatorRegistry {
  /**
   * Registers a stateless evaluator instance.
   * Throws EvaluatorRegistryError if an evaluator with the exact same id and version is already registered.
   */
  register(evaluator: IEvaluator): void;

  /**
   * Resolves an evaluator by ID and optional version.
   * If version is omitted, returns the highest semantic version registered for that ID.
   */
  resolve(id: EvaluatorId, version?: string): IEvaluator | undefined;

  /**
   * Checks if an evaluator with the specified ID (and optional version) is registered.
   */
  has(id: EvaluatorId, version?: string): boolean;

  /**
   * Returns a snapshot array of all currently registered evaluators.
   */
  list(): readonly IEvaluator[];

  /**
   * Clears all registered evaluators from the registry.
   */
  clear(): void;
}

export class EvaluatorRegistry implements IEvaluatorRegistry {
  private readonly evaluators = new Map<string, IEvaluator>();

  /**
   * Builds the internal composite lookup key.
   */
  private static makeKey(id: string, version: string): string {
    return `${id}@${version}`;
  }

  register(evaluator: IEvaluator): void {
    const raw = evaluator as unknown as Partial<IEvaluator> | null | undefined;
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) {
      throw new EvaluatorRegistryError(
        "INVALID_EVALUATOR",
        "Evaluator must provide a non-empty string ID",
      );
    }

    if (typeof raw.version !== "string" || raw.version.length === 0) {
      throw new EvaluatorRegistryError(
        "INVALID_VERSION",
        `Evaluator '${raw.id}' must provide a non-empty version string`,
      );
    }

    const key = EvaluatorRegistry.makeKey(raw.id, raw.version);
    if (this.evaluators.has(key)) {
      throw new EvaluatorRegistryError(
        "DUPLICATE_EVALUATOR",
        `Evaluator '${raw.id}' version '${raw.version}' is already registered`,
      );
    }

    this.evaluators.set(key, evaluator);
  }

  resolve(id: EvaluatorId, version?: string): IEvaluator | undefined {
    if (version !== undefined && version !== "") {
      return this.evaluators.get(EvaluatorRegistry.makeKey(id, version));
    }

    // Version omitted: collect all matching ID versions and resolve highest semver
    const candidates: { evaluator: IEvaluator; parsed: ParsedSemver | null }[] = [];
    for (const evaluator of this.evaluators.values()) {
      if (evaluator.id === id) {
        candidates.push({
          evaluator,
          parsed: parseSemver(evaluator.version),
        });
      }
    }

    if (candidates.length === 0) {
      return undefined;
    }

    // Sort valid semvers highest to lowest; unparseable semvers fall back to string comparison
    candidates.sort((a, b) => {
      if (a.parsed && b.parsed) {
        return compareSemver(b.parsed, a.parsed);
      }
      if (a.parsed && !b.parsed) {
        return -1;
      }
      if (!a.parsed && b.parsed) {
        return 1;
      }
      return b.evaluator.version.localeCompare(a.evaluator.version);
    });

    return candidates[0]?.evaluator;
  }

  has(id: EvaluatorId, version?: string): boolean {
    return this.resolve(id, version) !== undefined;
  }

  list(): readonly IEvaluator[] {
    return Array.from(this.evaluators.values());
  }

  clear(): void {
    this.evaluators.clear();
  }
}
