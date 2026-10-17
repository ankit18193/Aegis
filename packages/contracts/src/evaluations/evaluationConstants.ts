// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Domain — Shared Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum byte length for raw evaluator output snippets.
 * Applies to both EvaluationEvidence.rawOutputSnippet and EvaluatorOutput.rawOutputSnippet.
 * Raw outputs beyond this limit must be truncated before storage.
 */
export const MAX_RAW_OUTPUT_BYTES = 4096 as const;

/**
 * Maximum character length for suite/case names.
 */
export const EVAL_NAME_MAX_LENGTH = 100 as const;

/**
 * Maximum character length for suite/case descriptions.
 */
export const EVAL_DESCRIPTION_MAX_LENGTH = 1000 as const;
