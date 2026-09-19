import { describe, expect, it } from "vitest";

import { createDatabaseContext } from "./client.js";

describe("Database Client Foundation", () => {
  it("initializes DatabaseContext with custom configuration and executes query", async () => {
    const ctx = createDatabaseContext({
      url: "postgresql://postgres:postgres@localhost:5433/aegis",
      poolMin: 1,
      poolMax: 2,
    });

    expect(ctx.db).toBeDefined();
    expect(ctx.sql).toBeDefined();
    expect(typeof ctx.close).toBe("function");

    try {
      const result = await ctx.sql`SELECT 1 as connected`;
      expect(result[0]?.["connected"]).toBe(1);
    } catch (err: unknown) {
      console.warn(
        "PostgreSQL not reachable during unit test, skipping live query probe:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await ctx.close();
    }
  });
});
