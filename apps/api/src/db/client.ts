/**
 * Database client and connection pool initialization using postgres.js and Drizzle ORM.
 * Encapsulates driver connection pooling, health probes, and graceful teardown.
 */

import { loadDatabaseConfig, type DatabaseConfig } from "@aegis/config";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export interface DatabaseContext {
  readonly db: PostgresJsDatabase;
  readonly sql: Sql;
  readonly close: () => Promise<void>;
}

/**
 * Creates and initializes a PostgreSQL client and Drizzle ORM instance.
 */
export function createDatabaseContext(customConfig?: DatabaseConfig): DatabaseContext {
  const config = customConfig ?? loadDatabaseConfig();
  const url = config.url ?? "postgresql://postgres:postgres@localhost:5433/aegis";

  const sql = postgres(url, {
    max: config.poolMax,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {
      // Suppress noisy notices in logs
    },
  });

  const db = drizzle(sql);

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
