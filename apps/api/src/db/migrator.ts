/**
 * Programmatic migration runner using Drizzle ORM migrator.
 * Applies schema migrations deterministically from the migrations folder.
 */

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
  const folder = migrationsFolder ?? path.resolve(currentDir, "./migrations");
  await migrate(db, { migrationsFolder: folder });
}
