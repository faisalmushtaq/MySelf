-- MySelf server schema.
--
-- Two schemas, two database roles. `identity` holds anything that could name a
-- person; `research` holds the answers, keyed only by the derived participant
-- code. The research role has no grant on identity at all — the separation is
-- enforced by Postgres, not by everyone remembering to be careful. A narrow
-- linkage role is the only thing that can see both, and everything it does is
-- written to the audit log.
--
-- Nothing derived is stored. The server keeps the device's event log exactly as
-- it arrived and the dataset is computed from it on read, by the same code the
-- researcher view and the BIDS export use (D-35).

CREATE SCHEMA IF NOT EXISTS research;
CREATE SCHEMA IF NOT EXISTS identity;

-- ── Devices ──────────────────────────────────────────────────────────────
-- An iPad is enrolled once by an admin and gets a token. The token is stored
-- only as a SHA-256 hash: a dump of this table does not let anyone sync.
CREATE TABLE IF NOT EXISTS research.devices (
  device_id     text PRIMARY KEY,
  label         text NOT NULL,
  study         text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  enrolled_by   text NOT NULL,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- ── Sittings and their events ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.sessions (
  session_id    text PRIMARY KEY,
  device_id     text NOT NULL REFERENCES research.devices(device_id),
  study         text NOT NULL,
  study_code    text NOT NULL,
  release_key   text NOT NULL,
  release_hash  text NOT NULL,
  started_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  complete      boolean NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the same sitting arrives from a second device. The rows stay put;
  -- they are simply excluded from every read until a human decides.
  quarantined   boolean NOT NULL DEFAULT false
);

-- Events are append-only and identified by (session, seq). A replayed batch —
-- a retried upload, a re-import of an old export — is a no-op by construction
-- rather than by the client being careful.
CREATE TABLE IF NOT EXISTS research.events (
  session_id  text NOT NULL REFERENCES research.sessions(session_id),
  seq         integer NOT NULL,
  type        text NOT NULL,
  item_key    text,
  payload     jsonb,
  t_wall      timestamptz NOT NULL,
  t_mono      bigint NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS events_session_idx ON research.events (session_id);
CREATE INDEX IF NOT EXISTS sessions_study_idx ON research.sessions (study, started_at);

-- ── Sync receipts ────────────────────────────────────────────────────────
-- One row per accepted batch, so an interrupted upload resumes rather than
-- restarts, and so "did that sync actually land?" has an answer.
CREATE TABLE IF NOT EXISTS research.sync_receipts (
  batch_id      text PRIMARY KEY,
  device_id     text NOT NULL REFERENCES research.devices(device_id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  session_count integer NOT NULL,
  event_count   integer NOT NULL,
  ack_hash      text NOT NULL
);

-- ── Quarantine ───────────────────────────────────────────────────────────
-- Both copies are kept, whole and unedited. A conflict is a thing to look at,
-- never a thing to resolve by picking one automatically.
CREATE TABLE IF NOT EXISTS research.quarantine (
  quarantine_id  bigserial PRIMARY KEY,
  session_id     text NOT NULL,
  device_id      text NOT NULL,
  reason         text NOT NULL,
  payload        jsonb NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    text,
  resolution     text
);

-- ── Audit ────────────────────────────────────────────────────────────────
-- Append-only. Covers sign-in, enrolment, exports, identifier access and
-- deletions. Read by humans after something has gone wrong, so it records who,
-- what, when and against which study, and never a response value.
CREATE TABLE IF NOT EXISTS research.audit (
  audit_id   bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  study      text,
  subject    text,
  detail     jsonb
);

CREATE INDEX IF NOT EXISTS audit_at_idx ON research.audit (at DESC);

-- ── Identity (separate schema, separate role) ────────────────────────────
-- Present so the separation exists from the first migration rather than being
-- retrofitted. A study only writes here if it genuinely needs to hold a name.
CREATE TABLE IF NOT EXISTS identity.participants (
  participant_code text PRIMARY KEY,
  study            text NOT NULL,
  given_name       text,
  family_name      text,
  date_of_birth    date,
  contact          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_at     timestamptz
);

CREATE TABLE IF NOT EXISTS identity.access_log (
  access_id     bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  action        text NOT NULL,
  participant   text,
  justification text NOT NULL
);
