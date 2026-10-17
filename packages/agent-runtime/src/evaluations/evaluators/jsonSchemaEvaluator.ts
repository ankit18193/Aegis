import type {
  AssertionResult,
  EvaluatorErrorContract,
  EvaluatorInput,
  EvaluatorKind,
  EvaluatorMetricType,
  EvaluatorOutput,
  IEvaluator,
} from "@aegis/contracts";
import { MAX_RAW_OUTPUT_BYTES } from "@aegis/contracts";
import type { EvaluatorId, Result } from "@aegis/types";
import { evaluatorId, ok } from "@aegis/types";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schema & Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SCHEMA_DEPTH = 10;

export const jsonSchemaConfigSchema = z.object({
  schema: z.record(z.unknown()),
  requiredKeys: z.array(z.string()).optional(),
  maxOutputBytes: z.number().int().positive().default(MAX_RAW_OUTPUT_BYTES),
});
export type JsonSchemaConfig = z.infer<typeof jsonSchemaConfigSchema>;

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export class SchemaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaConfigurationError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft-07 Recursive Validator
// ─────────────────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(recordA[key], recordB[key])) {
      return false;
    }
  }
  return true;
}

interface JsonSchemaDefinition {
  type?: string | string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Record<string, unknown>;
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: boolean;
}

function validateSchemaNode(
  data: unknown,
  rawSchema: Record<string, unknown>,
  path: string,
  depth: number,
): void {
  const schema = rawSchema as JsonSchemaDefinition;
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new SchemaConfigurationError(
      `Schema nesting depth exceeded maximum allowable depth of ${String(MAX_SCHEMA_DEPTH)} at '${path}'`,
    );
  }

  // 1. Validate type constraint
  if (schema.type !== undefined) {
    const rawType = schema.type;
    const allowedTypes = Array.isArray(rawType) ? rawType : [rawType];

    const matchesType = allowedTypes.some((type) => {
      switch (type) {
        case "string":
          return typeof data === "string";
        case "number":
          return typeof data === "number" && !Number.isNaN(data);
        case "integer":
          return typeof data === "number" && Number.isInteger(data);
        case "boolean":
          return typeof data === "boolean";
        case "null":
          return data === null;
        case "object":
          return typeof data === "object" && data !== null && !Array.isArray(data);
        case "array":
          return Array.isArray(data);
        default:
          throw new SchemaConfigurationError(
            `Unsupported JSON Schema type '${type}' at '${path}'`,
          );
      }
    });

    if (!matchesType) {
      throw new SchemaValidationError(
        `Expected type ${allowedTypes.join(" | ")} at '${path}', got ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}`,
      );
    }
  }

  // 2. Enum constraint
  if ("enum" in schema && Array.isArray(schema.enum)) {
    const matched = schema.enum.some((enumVal) => deepEqual(data, enumVal));
    if (!matched) {
      throw new SchemaValidationError(
        `Value at '${path}' is not in allowed enum [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
      );
    }
  }

  // 3. String constraints
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      throw new SchemaValidationError(
        `String at '${path}' has length ${String(data.length)}, minimum is ${String(schema.minLength)}`,
      );
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      throw new SchemaValidationError(
        `String at '${path}' has length ${String(data.length)}, maximum is ${String(schema.maxLength)}`,
      );
    }
    if (typeof schema.pattern === "string") {
      let regex: RegExp;
      try {
        regex = new RegExp(schema.pattern);
      } catch (err) {
        throw new SchemaConfigurationError(
          `Invalid regex pattern '${schema.pattern}' at '${path}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!regex.test(data)) {
        throw new SchemaValidationError(
          `String at '${path}' does not match pattern /${schema.pattern}/`,
        );
      }
    }
  }

  // 4. Number constraints
  if (typeof data === "number" && !Number.isNaN(data)) {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      throw new SchemaValidationError(
        `Number at '${path}' is ${String(data)}, minimum is ${String(schema.minimum)}`,
      );
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      throw new SchemaValidationError(
        `Number at '${path}' is ${String(data)}, maximum is ${String(schema.maximum)}`,
      );
    }
    if (typeof schema.exclusiveMinimum === "number" && data <= schema.exclusiveMinimum) {
      throw new SchemaValidationError(
        `Number at '${path}' is ${String(data)}, exclusive minimum is ${String(schema.exclusiveMinimum)}`,
      );
    }
    if (typeof schema.exclusiveMaximum === "number" && data >= schema.exclusiveMaximum) {
      throw new SchemaValidationError(
        `Number at '${path}' is ${String(data)}, exclusive maximum is ${String(schema.exclusiveMaximum)}`,
      );
    }
  }

  // 5. Array constraints
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      throw new SchemaValidationError(
        `Array at '${path}' contains ${String(data.length)} items, minimum is ${String(schema.minItems)}`,
      );
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      throw new SchemaValidationError(
        `Array at '${path}' contains ${String(data.length)} items, maximum is ${String(schema.maxItems)}`,
      );
    }
    if (schema.items && typeof schema.items === "object") {
      const itemSchema = schema.items;
      data.forEach((item, index) => {
        validateSchemaNode(item, itemSchema, `${path}[${String(index)}]`, depth + 1);
      });
    }
  }

  // 6. Object constraints
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;

    // Required properties
    if (Array.isArray(schema.required)) {
      for (const requiredProp of schema.required) {
        if (typeof requiredProp === "string") {
          if (!Object.prototype.hasOwnProperty.call(record, requiredProp) || record[requiredProp] === undefined) {
            throw new SchemaValidationError(
              `Required property '${requiredProp}' is missing at '${path}'`,
            );
          }
        }
      }
    }

    // Property definitions
    const properties = schema.properties ?? {};
    for (const [propKey, propSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, propKey) && record[propKey] !== undefined) {
        validateSchemaNode(
          record[propKey],
          propSchema,
          path === "" ? propKey : `${path}.${propKey}`,
          depth + 1,
        );
      }
    }

    // Additional properties restriction
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(properties));
      for (const actualKey of Object.keys(record)) {
        if (!allowedKeys.has(actualKey)) {
          throw new SchemaValidationError(
            `Additional property '${actualKey}' is not permitted at '${path}'`,
          );
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JsonSchema Evaluator Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic evaluator verifying that an execution output is valid JSON and
 * strictly conforms to a specified JSON Schema Draft-07 specification.
 */
export class JsonSchemaEvaluator implements IEvaluator {
  readonly id: EvaluatorId = evaluatorId("json_schema");
  readonly version = "1.0.0";
  readonly kind: EvaluatorKind = "deterministic";
  readonly metricType: EvaluatorMetricType = "binary";

  evaluate(
    input: EvaluatorInput,
  ): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>> {
    // 1. Validate configuration
    const parsedConfig = jsonSchemaConfigSchema.safeParse(input.config ?? {});
    if (!parsedConfig.success) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "evaluator_error",
          reason: `Invalid JsonSchema configuration: ${parsedConfig.error.message}`,
          assertions: [],
        }),
      );
    }
    const { schema, requiredKeys, maxOutputBytes } = parsedConfig.data;

    // 2. Resolve output from evidence (target task output or run output)
    let output: string | undefined;
    if (input.target.taskId) {
      const task = input.executionEvidence.run.tasks.find(
        (t) => t.id === input.target.taskId,
      );
      if (!task) {
        return Promise.resolve(
          ok({
            verdict: "error",
            score: null,
            failureClassification: "missing_evidence",
            reason: `Target taskId '${input.target.taskId}' not found in execution evidence`,
            assertions: [],
          }),
        );
      }
      output = task.output;
    } else {
      output = input.executionEvidence.run.result?.summary;
    }

    // 3. Strict evidence completeness check: output undefined indicates missing evidence
    if (output === undefined) {
      return Promise.resolve(
        ok({
          verdict: "error",
          score: null,
          failureClassification: "missing_evidence",
          reason: "Execution evidence contains no output string to evaluate",
          assertions: [],
        }),
      );
    }

    const rawOutputSnippet = input.captureRawOutput
      ? output.slice(0, MAX_RAW_OUTPUT_BYTES)
      : undefined;

    // 4. Resource limit: maxOutputBytes
    if (output.length > maxOutputBytes) {
      const assertion: AssertionResult = {
        name: "output_size_limit",
        passed: false,
        message: `Output byte length (${String(output.length)}) exceeds configured maximum (${String(maxOutputBytes)})`,
      };
      return Promise.resolve(
        ok({
          verdict: "fail",
          score: 0.0,
          failureClassification: "schema_violation",
          reason: assertion.message ?? "",
          assertions: [assertion],
          ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
        }),
      );
    }

    // 5. JSON Syntax Validation
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(output);
    } catch (parseError) {
      const assertion: AssertionResult = {
        name: "json_syntax",
        passed: false,
        message: `Output is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
      return Promise.resolve(
        ok({
          verdict: "fail",
          score: 0.0,
          failureClassification: "schema_violation",
          reason: assertion.message ?? "",
          assertions: [assertion],
          ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
        }),
      );
    }

    const assertions: AssertionResult[] = [
      {
        name: "json_syntax",
        passed: true,
        message: "Output parsed successfully as valid JSON",
      },
    ];

    // 6. JSON Schema Validation
    try {
      validateSchemaNode(parsedJson, schema, "$", 0);
      assertions.push({
        name: "schema_conformance",
        passed: true,
        message: "Output conforms to JSON Schema specification",
      });
    } catch (err) {
      if (err instanceof SchemaConfigurationError) {
        return Promise.resolve(
          ok({
            verdict: "error",
            score: null,
            failureClassification: "evaluator_error",
            reason: `Invalid schema definition: ${err.message}`,
            assertions,
            ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
          }),
        );
      }

      const violationMessage = err instanceof Error ? err.message : String(err);
      assertions.push({
        name: "schema_conformance",
        passed: false,
        message: `JSON Schema violation: ${violationMessage}`,
      });
      return Promise.resolve(
        ok({
          verdict: "fail",
          score: 0.0,
          failureClassification: "schema_violation",
          reason: `JSON Schema violation: ${violationMessage}`,
          assertions,
          ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
        }),
      );
    }

    // 7. Top-level required keys check (if specified in config)
    if (requiredKeys && requiredKeys.length > 0) {
      if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
        assertions.push({
          name: "required_keys",
          passed: false,
          message: "Cannot check requiredKeys on non-object JSON payload",
        });
        return Promise.resolve(
          ok({
            verdict: "fail",
            score: 0.0,
            failureClassification: "schema_violation",
            reason: "Cannot check requiredKeys on non-object JSON payload",
            assertions,
            ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
          }),
        );
      }

      const record = parsedJson as Record<string, unknown>;
      const missingKeys = requiredKeys.filter(
        (key) => !Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined,
      );

      if (missingKeys.length > 0) {
        assertions.push({
          name: "required_keys",
          passed: false,
          message: `Missing required top-level key(s): ${missingKeys.join(", ")}`,
        });
        return Promise.resolve(
          ok({
            verdict: "fail",
            score: 0.0,
            failureClassification: "schema_violation",
            reason: `Missing required top-level key(s): ${missingKeys.join(", ")}`,
            assertions,
            ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
          }),
        );
      }

      assertions.push({
        name: "required_keys",
        passed: true,
        message: `All required top-level keys present: ${requiredKeys.join(", ")}`,
      });
    }

    // 8. Success: All checks passed
    return Promise.resolve(
      ok({
        verdict: "pass",
        score: 1.0,
        reason: "Output conforms to JSON Schema and syntax constraints",
        assertions,
        ...(rawOutputSnippet !== undefined ? { rawOutputSnippet } : {}),
      }),
    );
  }
}
