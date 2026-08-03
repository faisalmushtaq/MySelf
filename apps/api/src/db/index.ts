import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The one thing the rest of the server knows about the database.
 *
 * A two-method interface, not an ORM: every statement in this codebase is
 * visible SQL, because the schema separation between `identity` and `research`
 * is a security control and a control you cannot read is not a control.
 *
 * It is also what lets the tests run against an embedded Postgres with no
 * daemon, executing exactly the SQL production executes.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a unit of work in one transaction; a throw rolls the whole thing back. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export function migrationFiles(includeRoles: boolean): { name: string; sql: string }[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => includeRoles || !f.includes("roles"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));
}

/**
 * Apply every migration that has not run yet.
 *
 * Migrations are recorded by name in a table the migration runner owns. They
 * are written to be safe to re-run, but the record is what makes a deploy
 * idempotent when two API containers start at the same moment.
 */
export async function migrate(db: Db, options: { includeRoles?: boolean } = {}): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM public.schema_migrations")).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const migration of migrationFiles(options.includeRoles ?? true)) {
    if (applied.has(migration.name)) continue;
    await db.query(migration.sql);
    await db.query("INSERT INTO public.schema_migrations (name) VALUES ($1)", [migration.name]);
    ran.push(migration.name);
  }
  return ran;
}
