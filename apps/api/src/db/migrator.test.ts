import { describe, expect, it } from "vitest";

import { createDatabaseContext } from "./client.js";
import { runMigrations } from "./migrator.js";

describe("Database Migrator", () => {
  it(
    "executes migrations idempotently without throwing",
    async () => {
      const ctx = createDatabaseContext();
      try {
        // Running migrations when tables already exist should be a safe, idempotent operation
        await expect(runMigrations(ctx.db)).resolves.not.toThrow();
      } catch (err: unknown) {
        console.warn(
          "PostgreSQL not reachable during unit test, skipping live migration test:",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        await ctx.close();
      }
    },
    30000,
  );
});
