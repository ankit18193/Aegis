/**
 * Programmatic migration runner using Drizzle ORM migrator.
 * Applies schema migrations deterministically from the migrations folder.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Runs pending database migrations.
 */
export async function runMigrations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>,
  migrationsFolder?: string,
): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let folder = migrationsFolder ?? path.resolve(currentDir, "./migrations");

  if (!fs.existsSync(folder) || !fs.existsSync(path.resolve(folder, "meta/_journal.json"))) {
    const srcFallback = path.resolve(currentDir, "../../src/db/migrations");
    if (fs.existsSync(srcFallback) && fs.existsSync(path.resolve(srcFallback, "meta/_journal.json"))) {
      folder = srcFallback;
    }
  }

  await migrate(db, { migrationsFolder: folder });
}
