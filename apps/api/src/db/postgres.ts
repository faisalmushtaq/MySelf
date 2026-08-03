import pg from "pg";
import type { Db, QueryResult } from "./index.js";

/**
 * The production driver. One pool, connecting as the research role.
 *
 * `application_name` is set so a query holding a lock at two in the morning can
 * be traced back to this service rather than to "node".
 */

export interface PostgresOptions {
  connectionString: string;
  /** Refuse to start against a database reachable without TLS in production. */
  ssl?: boolean;
  max?: number;
}

export function createPostgres(options: PostgresOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: "myself-api",
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  const wrap = (runner: pg.Pool | pg.PoolClient): Db => ({
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await runner.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // Nested transactions would need savepoints; the server has no use for
      // them, so this refuses rather than pretending.
      if (runner !== pool) throw new Error("already in a transaction");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (runner === pool) await pool.end();
    },
  });

  return wrap(pool);
}
