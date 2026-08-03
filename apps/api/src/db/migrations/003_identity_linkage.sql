-- Linkage: pulling a name back out when you need to, and joining to the UPN.
--
-- Two operational facts drive this schema:
--
--   1. Participants mistype their code, most often at a later wave. Their
--      sittings then arrive as a stranger's. Somebody has to be able to look at
--      the name and say "that is the same child" and record the correction.
--   2. Schools provide a UPN. Linking to it is how this study joins to
--      attainment and attendance, and the join is made on the name the school
--      knows, not on a code the school has never seen.
--
-- Both are reasons to hold names — and reasons to hold them HERE, behind a
-- different role, with every read logged, rather than in the response data.

-- The registry. One row per person, keyed on the code their answers are filed
-- under. Written from the identity partition that ingest keeps separate.
ALTER TABLE identity.participants
  ADD COLUMN IF NOT EXISTS upn text,
  ADD COLUMN IF NOT EXISTS upn_source text,
  ADD COLUMN IF NOT EXISTS upn_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS upn_linked_by text;

-- A UPN identifies one pupil, so two participants holding the same one is a
-- mistake worth refusing at the point of entry rather than finding in an
-- analysis. Partial, so the many rows with no UPN yet do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS participants_upn_unique
  ON identity.participants (study, upn) WHERE upn IS NOT NULL;

CREATE INDEX IF NOT EXISTS participants_name_idx
  ON identity.participants (study, lower(family_name), lower(given_name));

-- What a participant typed, wave by wave, whether or not it was right. Kept so
-- a correction can be reasoned about later: "she gave JE at wave 2 and JA at
-- waves 1 and 3" is the evidence for the join, and it has to survive.
CREATE TABLE IF NOT EXISTS identity.code_claims (
  claim_id         bigserial PRIMARY KEY,
  study            text NOT NULL,
  session_id       text NOT NULL,
  claimed_code     text NOT NULL,
  given_name       text,
  family_name      text,
  date_of_birth    date,
  recorded_at      timestamptz NOT NULL,
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS code_claims_code_idx ON identity.code_claims (study, claimed_code);

-- Corrections. Applied when the dataset is derived, never to the event log:
-- the log records what the child actually typed, which is the only honest
-- account of the sitting. Withdrawing a correction here undoes it completely.
CREATE TABLE IF NOT EXISTS research.code_corrections (
  correction_id  bigserial PRIMARY KEY,
  study          text NOT NULL,
  wrong_code     text NOT NULL,
  right_code     text NOT NULL,
  reason         text NOT NULL,
  made_by        text NOT NULL,
  made_at        timestamptz NOT NULL DEFAULT now(),
  withdrawn_at   timestamptz,
  withdrawn_by   text,
  CHECK (wrong_code <> right_code)
);

-- One live correction per wrong code: two different answers to "who is this
-- really?" is a question for a human, not something to resolve by row order.
CREATE UNIQUE INDEX IF NOT EXISTS code_corrections_live
  ON research.code_corrections (study, wrong_code) WHERE withdrawn_at IS NULL;
