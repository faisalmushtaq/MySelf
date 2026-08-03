import { PGlite } from "@electric-sql/pglite";
import type { Db, QueryResult } from "../db/index.js";

/**
 * Postgres for tests, without a daemon.
 *
 * PGlite is the real Postgres engine compiled to WebAssembly, so the tests run
 * exactly the SQL production runs — the ON CONFLICT clauses, the JSONB columns,
 * the transaction that has to roll a whole batch back. A mock database would
 * pass while the statements it stood in for were wrong, which is the failure
 * mode that matters for a sync endpoint.
 *
 * It is single-connection, so `transaction` here is a real BEGIN/COMMIT on that
 * one connection rather than a pooled checkout. Role creation is skipped: a
 * cluster with one user has nothing to grant.
 */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  let depth = 0;

  const db: Db = {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = params && params.length > 0 ? await pg.query(sql, params) : await pg.exec(sql);
      if (Array.isArray(result)) {
        const last = result[result.length - 1];
        return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? last?.rows?.length ?? 0 };
      }
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
    },
    async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (depth > 0) throw new Error("already in a transaction");
      depth += 1;
      try {
        await pg.exec("BEGIN");
        const out = await fn(db);
        await pg.exec("COMMIT");
        return out;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
    async close() {
      await pg.close();
    },
  };

  return db;
}
