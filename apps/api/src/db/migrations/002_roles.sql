-- Database roles.
--
-- Kept in its own migration because it is the one part of the schema that is
-- about privilege rather than shape, and because a test harness running an
-- embedded Postgres has no business creating cluster roles. The API connects as
-- `myself_research` in production; nothing it can be tricked into running can
-- read a name, because the grant does not exist.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'myself_research') THEN
    CREATE ROLE myself_research NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'myself_linkage') THEN
    CREATE ROLE myself_linkage NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA research TO myself_research;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA research TO myself_research;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA research TO myself_research;
ALTER DEFAULT PRIVILEGES IN SCHEMA research
  GRANT SELECT, INSERT, UPDATE ON TABLES TO myself_research;

-- The point of the exercise: no grant on identity for the research role.
REVOKE ALL ON SCHEMA identity FROM myself_research;
REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM myself_research;

-- The linkage role sees both, and is used only by the linkage endpoints, which
-- write to identity.access_log on every call.
GRANT USAGE ON SCHEMA identity, research TO myself_linkage;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity TO myself_linkage;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO myself_linkage;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE ON TABLES TO myself_linkage;

-- Deletion is a workflow with a tombstone, never an ad-hoc DELETE by the API.
REVOKE DELETE ON ALL TABLES IN SCHEMA research FROM myself_research;
REVOKE DELETE ON ALL TABLES IN SCHEMA identity FROM myself_linkage;
