import { describe, expect, it } from "vitest";

import { jsonSchemaToZod } from "./schema.js";

describe("MCP JSON Schema to Zod Translator", () => {
  it("translates null, undefined, or empty schema to an empty ZodObject", () => {
    const res1 = jsonSchemaToZod(null);
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.value.safeParse({}).success).toBe(true);

    const res2 = jsonSchemaToZod(undefined);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.value.safeParse({}).success).toBe(true);

    const res3 = jsonSchemaToZod({});
    expect(res3.ok).toBe(true);
    if (!res3.ok) return;
    expect(res3.value.safeParse({}).success).toBe(true);
  });

  it("translates primitive properties (string, number, integer, boolean)", () => {
    const schema = {
      type: "object",
      properties: {
        str: { type: "string", minLength: 2, maxLength: 10, description: "A string field" },
        num: { type: "number", minimum: 0, maximum: 100 },
        intVal: { type: "integer", minimum: 1 },
        flag: { type: "boolean", default: true },
      },
      required: ["str", "num", "intVal"],
    };

    const res = jsonSchemaToZod(schema, "test_tool");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const zodSchema = res.value;

    // Valid object
    const valid = zodSchema.safeParse({
      str: "hello",
      num: 45.5,
      intVal: 10,
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data["flag"]).toBe(true); // default applied
    }

    // Invalid string length
    const invalidStr = zodSchema.safeParse({
      str: "a",
      num: 10,
      intVal: 5,
    });
    expect(invalidStr.success).toBe(false);

    // Invalid non-integer
    const invalidInt = zodSchema.safeParse({
      str: "hello",
      num: 10,
      intVal: 5.5,
    });
    expect(invalidInt.success).toBe(false);

    // Missing required field
    const missingReq = zodSchema.safeParse({
      str: "hello",
      num: 10,
    });
    expect(missingReq.success).toBe(false);
  });

  it("supports string enums and regex patterns", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "write", "admin"] },
        code: { type: "string", pattern: "^[A-Z]{3}-\\d{3}$" },
      },
      required: ["mode"],
    };

    const res = jsonSchemaToZod(schema);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const parsed = res.value.safeParse({ mode: "read", code: "ABC-123" });
    expect(parsed.success).toBe(true);

    const badEnum = res.value.safeParse({ mode: "superuser" });
    expect(badEnum.success).toBe(false);

    const badRegex = res.value.safeParse({ mode: "read", code: "abc" });
    expect(badRegex.success).toBe(false);
  });

  it("translates nested objects and array schemas", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
        },
        metadata: {
          type: "object",
          properties: {
            author: { type: "string" },
            score: { type: "integer" },
          },
          required: ["author"],
        },
      },
      required: ["tags"],
    };

    const res = jsonSchemaToZod(schema, "nested_tool");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const valid = res.value.safeParse({
      tags: ["ai", "agent"],
      metadata: { author: "Alice", score: 99 },
    });
    expect(valid.success).toBe(true);

    const invalidItem = res.value.safeParse({
      tags: [1, 2],
    });
    expect(invalidItem.success).toBe(false);

    const missingAuthor = res.value.safeParse({
      tags: ["ok"],
      metadata: { score: 10 },
    });
    expect(missingAuthor.success).toBe(false);
  });

  it("rejects non-object root schema with McpError.unsupportedSchema", () => {
    const nonObj = {
      type: "string",
    };
    const res = jsonSchemaToZod(nonObj, "str_tool");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(res.error.message).toContain("Root tool schema must be of type 'object'");
  });

  it("rejects array schemas without items definition", () => {
    const badArray = {
      type: "object",
      properties: {
        list: { type: "array" },
      },
    };
    const res = jsonSchemaToZod(badArray, "bad_array_tool");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(res.error.message).toContain("must specify an 'items' schema");
  });

  it("rejects unsupported complex keywords (anyOf, oneOf, allOf, $ref, not)", () => {
    const unsupportedConstructs = [
      { type: "object", anyOf: [{ properties: { a: { type: "string" } } }] },
      { type: "object", oneOf: [{ properties: { b: { type: "number" } } }] },
      { type: "object", allOf: [{ properties: { c: { type: "boolean" } } }] },
      { type: "object", properties: { item: { $ref: "#/definitions/item" } } },
      { type: "object", not: { properties: { x: { type: "string" } } } },
      { type: "object", patternProperties: { "^foo.*$": { type: "string" } } },
    ];

    for (const schema of unsupportedConstructs) {
      const res = jsonSchemaToZod(schema, "complex_tool");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    }
  });

  it("rejects union types in 'type'", () => {
    const schema = {
      type: "object",
      properties: {
        val: { type: ["string", "null"] },
      },
    };
    const res = jsonSchemaToZod(schema, "union_tool");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(res.error.message).toContain("Union types in 'type'");
  });

  it("rejects required fields that are not defined in properties", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
      },
      required: ["a", "b"],
    };
    const res = jsonSchemaToZod(schema, "ghost_required");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(res.error.message).toContain("Property 'b' listed in 'required' is not defined in 'properties'");
  });

  it("rejects unsupported types like 'date' or 'symbol'", () => {
    const schema = {
      type: "object",
      properties: {
        created: { type: "date" },
      },
    };
    const res = jsonSchemaToZod(schema, "date_tool");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(res.error.message).toContain("Unsupported schema type 'date'");
  });
});
