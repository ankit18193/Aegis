/**
 * Execution policy for the Aegis Agent Runtime.
 * Defines guardrails to ensure deterministic termination.
 */

export interface ExecutionPolicy {
  /** Maximum number of planning/action iterations before halting with failure */
  readonly maxIterations: number;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  maxIterations: 10,
};
