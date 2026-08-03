import { migrate } from "./index.js";
import { createPostgres } from "./postgres.js";

/**
 * Run migrations and stop. Used by the container's start command and by hand
 * during a deploy, so applying the schema never requires starting the API.
 */
const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createPostgres({ connectionString: url, ssl: process.env["PGSSL"] === "require" });
const ran = await migrate(db, { includeRoles: process.env["MYSELF_SKIP_ROLE_MIGRATION"] !== "1" });
console.log(ran.length === 0 ? "schema already up to date" : `applied: ${ran.join(", ")}`);
await db.close();
