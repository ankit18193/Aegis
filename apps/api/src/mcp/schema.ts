/**
 * JSON Schema to Zod translator for Aegis MCP integration.
 * Enforces strict validation of supported Phase 8 schema constructs:
 * - Primitives: string, number, integer, boolean
 * - Arrays with items schema
 * - Objects with required and optional properties
 * - Descriptions and defaults
 *
 * Explicitly rejects unsupported constructs (unions, anyOf, oneOf, allOf, $ref,
 * patternProperties) with structured McpError.unsupportedSchema.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import { z } from "zod";

import { McpError } from "./errors.js";

const UNSUPPORTED_KEYWORDS = [
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "$schema",
  "not",
  "patternProperties",
  "if",
  "then",
  "else",
] as const;

interface RawJsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly unknown[];
  readonly items?: unknown;
  readonly description?: unknown;
  readonly default?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly minLength?: unknown;
  readonly maxLength?: unknown;
  readonly pattern?: unknown;
  readonly enum?: readonly unknown[];
  readonly [key: string]: unknown;
}

function checkUnsupportedKeywords(raw: RawJsonSchema, toolName: string, path: string): McpError | null {
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in raw && raw[kw] !== undefined) {
      return McpError.unsupportedSchema(
        toolName,
        `Construct '${kw}' at '${path || "root"}' is not supported in Phase 8.`,
        raw,
      );
    }
  }
  return null;
}

function translateNode(
  raw: unknown,
  toolName: string,
  path: string,
): Result<z.ZodTypeAny, McpError> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(
      McpError.unsupportedSchema(
        toolName,
        `Schema definition at '${path || "root"}' must be a JSON object.`,
        raw,
      ),
    );
  }

  const schema = raw as RawJsonSchema;

  const unsupportedErr = checkUnsupportedKeywords(schema, toolName, path);
  if (unsupportedErr) {
    return err(unsupportedErr);
  }

  // Handle union types: e.g. type: ["string", "null"]
  if (Array.isArray(schema.type)) {
    return err(
      McpError.unsupportedSchema(
        toolName,
        `Union types in 'type' at '${path || "root"}' are not supported in Phase 8.`,
        schema,
      ),
    );
  }

  // Infer object if properties exist but type is omitted
  let type = schema.type;
  if (!type && schema.properties) {
    type = "object";
  }

  if (!type) {
    // If empty object {}
    if (Object.keys(schema).length === 0) {
      return ok(z.object({}));
    }
    return err(
      McpError.unsupportedSchema(
        toolName,
        `Missing 'type' specification in schema at '${path || "root"}'.`,
        schema,
      ),
    );
  }

  if (typeof type !== "string") {
    return err(
      McpError.unsupportedSchema(
        toolName,
        `Schema 'type' at '${path || "root"}' must be a string.`,
        schema,
      ),
    );
  }

  switch (type) {
    case "string": {
      let zodStr: z.ZodTypeAny;

      if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
          return err(
            McpError.unsupportedSchema(
              toolName,
              `'enum' at '${path}' must be a non-empty array of strings.`,
              schema,
            ),
          );
        }
        for (const item of schema.enum) {
          if (typeof item !== "string") {
            return err(
              McpError.unsupportedSchema(
                toolName,
                `'enum' elements at '${path}' must be strings.`,
                schema,
              ),
            );
          }
        }
        const stringValues = schema.enum as [string, ...string[]];
        zodStr = z.enum(stringValues);
      } else {
        let base = z.string();
        if (typeof schema.minLength === "number") {
          base = base.min(schema.minLength);
        }
        if (typeof schema.maxLength === "number") {
          base = base.max(schema.maxLength);
        }
        if (typeof schema.pattern === "string") {
          try {
            base = base.regex(new RegExp(schema.pattern));
          } catch (e) {
            return err(
              McpError.unsupportedSchema(
                toolName,
                `Invalid regex pattern '${schema.pattern}' at '${path}': ${String(e)}`,
                schema,
              ),
            );
          }
        }
        zodStr = base;
      }

      if (typeof schema.description === "string") {
        zodStr = zodStr.describe(schema.description);
      }
      if (typeof schema.default === "string") {
        zodStr = zodStr.default(schema.default);
      }

      return ok(zodStr);
    }

    case "number":
    case "integer": {
      let base = z.number();
      if (type === "integer") {
        base = base.int();
      }
      if (typeof schema.minimum === "number") {
        base = base.min(schema.minimum);
      }
      if (typeof schema.maximum === "number") {
        base = base.max(schema.maximum);
      }

      let zodNum: z.ZodTypeAny = base;
      if (typeof schema.description === "string") {
        zodNum = zodNum.describe(schema.description);
      }
      if (typeof schema.default === "number") {
        zodNum = zodNum.default(schema.default);
      }

      return ok(zodNum);
    }

    case "boolean": {
      let zodBool: z.ZodTypeAny = z.boolean();
      if (typeof schema.description === "string") {
        zodBool = zodBool.describe(schema.description);
      }
      if (typeof schema.default === "boolean") {
        zodBool = zodBool.default(schema.default);
      }
      return ok(zodBool);
    }

    case "array": {
      if (schema.items === undefined) {
        return err(
          McpError.unsupportedSchema(
            toolName,
            `Array schema at '${path || "root"}' must specify an 'items' schema.`,
            schema,
          ),
        );
      }

      const itemRes = translateNode(schema.items, toolName, `${path || "root"}.items`);
      if (!itemRes.ok) {
        return itemRes;
      }

      let zodArr: z.ZodTypeAny = z.array(itemRes.value);
      if (typeof schema.description === "string") {
        zodArr = zodArr.describe(schema.description);
      }

      return ok(zodArr);
    }

    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      const requiredSet = new Set<string>();

      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) {
          return err(
            McpError.unsupportedSchema(
              toolName,
              `'required' property at '${path || "root"}' must be an array of strings.`,
              schema,
            ),
          );
        }
        for (const req of schema.required) {
          if (typeof req !== "string") {
            return err(
              McpError.unsupportedSchema(
                toolName,
                `'required' elements at '${path || "root"}' must be strings.`,
                schema,
              ),
            );
          }
          requiredSet.add(req);
        }
      }

      if (schema.properties !== undefined) {
        if (typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
          return err(
            McpError.unsupportedSchema(
              toolName,
              `'properties' at '${path || "root"}' must be an object map.`,
              schema,
            ),
          );
        }

        for (const [propName, propDef] of Object.entries(schema.properties)) {
          const propPath = path ? `${path}.${propName}` : propName;
          const propRes = translateNode(propDef, toolName, propPath);
          if (!propRes.ok) {
            return propRes;
          }

          let propZod = propRes.value;
          const propRaw = (typeof propDef === "object" && propDef !== null) ? (propDef as RawJsonSchema) : undefined;
          if (!requiredSet.has(propName)) {
            if (propRaw?.default === undefined) {
              propZod = propZod.optional();
            }
          }

          shape[propName] = propZod;
        }

        // Validate that all required properties are declared in properties
        for (const reqName of requiredSet) {
          if (!(reqName in schema.properties)) {
            return err(
              McpError.unsupportedSchema(
                toolName,
                `Property '${reqName}' listed in 'required' is not defined in 'properties' at '${path || "root"}'.`,
                schema,
              ),
            );
          }
        }
      }

      let zodObj: z.ZodTypeAny = z.object(shape);
      if (typeof schema.description === "string") {
        zodObj = zodObj.describe(schema.description);
      }

      return ok(zodObj);
    }

    default:
      return err(
        McpError.unsupportedSchema(
          toolName,
          `Unsupported schema type '${type}' at '${path || "root"}'.`,
          schema,
        ),
      );
  }
}

/**
 * Translates an MCP tool input JSON Schema into an authoritative Zod object schema.
 * Rejects unsupported schemas with McpError.unsupportedSchema.
 */
export function jsonSchemaToZod(
  schema: unknown,
  toolName = "unknown",
): Result<z.ZodObject<Record<string, z.ZodTypeAny>>, McpError> {
  // Empty or undefined schema maps to empty object schema
  if (schema === undefined || schema === null) {
    return ok(z.object({}));
  }

  if (typeof schema !== "object" || Array.isArray(schema)) {
    return err(
      McpError.unsupportedSchema(
        toolName,
        "Root tool inputSchema must be a JSON object.",
        schema,
      ),
    );
  }

  const raw = schema as RawJsonSchema;
  if (Object.keys(raw).length === 0) {
    return ok(z.object({}));
  }

  // Root must be an object schema
  let rootType = raw.type;
  if (!rootType && raw.properties) {
    rootType = "object";
  }

  if (rootType && rootType !== "object") {
    return err(
      McpError.unsupportedSchema(
        toolName,
        `Root tool schema must be of type 'object', received '${String(rootType)}'.`,
        schema,
      ),
    );
  }

  const res = translateNode(schema, toolName, "");
  if (!res.ok) {
    return res;
  }

  if (!(res.value instanceof z.ZodObject)) {
    return err(
      McpError.unsupportedSchema(
        toolName,
        "Root tool schema did not produce a ZodObject.",
        schema,
      ),
    );
  }

  return ok(res.value as z.ZodObject<Record<string, z.ZodTypeAny>>);
}
