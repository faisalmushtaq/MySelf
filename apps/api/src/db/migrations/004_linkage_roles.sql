-- Grants for the linkage tables.
--
-- Separate from the table definitions for the same reason as 002: privilege is
-- a cluster concern, and a test harness running an embedded Postgres with a
-- single user has no roles to grant to. Keeping every GRANT in a file the
-- runner can skip is what lets the tests execute the real schema.

GRANT SELECT, INSERT, UPDATE ON identity.code_claims TO myself_linkage;
GRANT SELECT, INSERT, UPDATE ON identity.participants TO myself_linkage;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO myself_linkage;

-- Corrections live in `research` because they are facts about the dataset, not
-- about a person: the research role reads them to derive, and only the linkage
-- role may write one.
GRANT SELECT ON research.code_corrections TO myself_research;
GRANT INSERT, UPDATE ON research.code_corrections TO myself_linkage;
GRANT USAGE ON SCHEMA research TO myself_linkage;
