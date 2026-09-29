import { z } from "zod";
import type { Db } from "../db/index.js";
import { audit } from "../auth.js";
import { parseHomeAddress, type HomeAddress } from "@myself/store";

/**
 * The linkage service.
 *
 * This is the part of the platform that can turn a code back into a child, and
 * it exists because two things genuinely require it: repairing a mistyped code
 * so a participant's waves join up, and linking to the UPN a school provides so
 * the study can join to school records.
 *
 * Because it can do that, it is built to be used reluctantly:
 *
 *   - every call needs a written justification, stored with the row
 *   - every call is logged whether it found anything or not, so a search that
 *     returned nothing is still visible afterwards
 *   - it is owner-only, and it is the only route in the API that touches the
 *     identity schema
 *   - it returns the smallest answer that does the job: a search gives codes
 *     and match quality, not a list of children
 *
 * None of that stops a determined person with the owner role. It makes what
 * they did visible, which is the achievable goal.
 */

export const justification = z
  .string()
  .min(12, "say why this lookup is needed — it is recorded against your name");

export const lookupShape = z.object({
  participantCode: z.string().min(1),
  justification,
});

export const searchShape = z.object({
  study: z.string().min(1),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  upn: z.string().optional(),
  justification,
});

export const upnShape = z.object({
  study: z.string().min(1),
  participantCode: z.string().min(1),
  upn: z.string().min(1),
  source: z.string().min(1),
  justification,
});

export const correctionShape = z.object({
  study: z.string().min(1),
  wrongCode: z.string().min(1),
  rightCode: z.string().min(1),
  reason: z.string().min(12, "record why these are the same person"),
});

async function logAccess(
  db: Db,
  entry: { actor: string; action: string; participant?: string; justification: string },
): Promise<void> {
  await db.query(
    "INSERT INTO identity.access_log (actor, action, participant, justification) VALUES ($1, $2, $3, $4)",
    [entry.actor, entry.action, entry.participant ?? null, entry.justification],
  );
}

export interface IdentityRecord {
  participantCode: string;
  givenName: string | null;
  familyName: string | null;
  dateOfBirth: string | null;
  /** From the most recent sitting that gave one (r8.0.0 on, D-52). */
  homeAddress: HomeAddress | null;
  upn: string | null;
  study: string;
}

/** Code -> person. The "who is this?" direction. */
export async function lookupByCode(
  db: Db,
  actor: string,
  input: z.infer<typeof lookupShape>,
): Promise<IdentityRecord | null> {
  // Logged before the read, so an attempt that returns nothing still leaves a
  // trace. A log written only on success is a log of successes.
  await logAccess(db, {
    actor,
    action: "identity.lookup",
    participant: input.participantCode,
    justification: input.justification,
  });
  const { rows } = await db.query<{
    participant_code: string;
    given_name: string | null;
    family_name: string | null;
    date_of_birth: Date | null;
    home_address: HomeAddress | null;
    upn: string | null;
    study: string;
  }>(
    `SELECT participant_code, given_name, family_name, date_of_birth, home_address, upn, study
       FROM identity.participants WHERE participant_code = $1`,
    [input.participantCode],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    participantCode: row.participant_code,
    givenName: row.given_name,
    familyName: row.family_name,
    dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth).toISOString().slice(0, 10) : null,
    homeAddress: row.home_address ?? null,
    upn: row.upn,
    study: row.study,
  };
}

export interface SearchHit {
  participantCode: string;
  matchedOn: string;
  /** Every code this person has ever typed, right or wrong. */
  claimedCodes: string[];
}

/**
 * Person -> code. The direction used when somebody has given the wrong code
 * and their sittings need finding.
 *
 * Searches the claims as well as the registry, because the whole point is to
 * find a sitting that was filed under a code nobody expected.
 */
export async function searchByPerson(
  db: Db,
  actor: string,
  input: z.infer<typeof searchShape>,
): Promise<SearchHit[]> {
  await logAccess(db, {
    actor,
    action: "identity.search",
    participant: input.upn ?? `${input.givenName ?? ""} ${input.familyName ?? ""}`.trim(),
    justification: input.justification,
  });

  if (!input.upn && !input.familyName && !input.givenName) return [];

  const { rows } = await db.query<{ participant_code: string; matched_on: string }>(
    `SELECT participant_code,
            CASE WHEN $2::text IS NOT NULL AND upn = $2 THEN 'upn' ELSE 'name' END AS matched_on
       FROM identity.participants
      WHERE study = $1
        AND (
          ($2::text IS NOT NULL AND upn = $2)
          OR ($3::text IS NOT NULL AND lower(family_name) = lower($3)
              AND ($4::text IS NULL OR lower(given_name) = lower($4)))
        )
      ORDER BY participant_code`,
    [input.study, input.upn ?? null, input.familyName ?? null, input.givenName ?? null],
  );

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const claims = await db.query<{ claimed_code: string }>(
      "SELECT DISTINCT claimed_code FROM identity.code_claims WHERE study = $1 AND claimed_code = ANY($2)",
      [input.study, [row.participant_code]],
    );
    hits.push({
      participantCode: row.participant_code,
      matchedOn: row.matched_on,
      claimedCodes: claims.rows.map((c) => c.claimed_code),
    });
  }

  // Also surface codes claimed under this person's name that are not in the
  // registry at all — that is exactly what a mistyped code looks like.
  if (input.familyName) {
    const orphans = await db.query<{ claimed_code: string }>(
      `SELECT DISTINCT c.claimed_code
         FROM identity.code_claims c
    LEFT JOIN identity.participants p ON p.participant_code = c.claimed_code
        WHERE c.study = $1
          AND lower(c.family_name) = lower($2)
          AND ($3::text IS NULL OR lower(c.given_name) = lower($3))
          AND p.participant_code IS NULL`,
      [input.study, input.familyName, input.givenName ?? null],
    );
    for (const orphan of orphans.rows) {
      if (hits.some((h) => h.participantCode === orphan.claimed_code)) continue;
      hits.push({ participantCode: orphan.claimed_code, matchedOn: "claimed-name", claimedCodes: [orphan.claimed_code] });
    }
  }

  return hits;
}

/** Attach the UPN a school gave for this participant. */
export async function linkUpn(db: Db, actor: string, input: z.infer<typeof upnShape>): Promise<{ linked: boolean; conflict?: string }> {
  await logAccess(db, {
    actor,
    action: "identity.link_upn",
    participant: input.participantCode,
    justification: input.justification,
  });

  const clash = await db.query<{ participant_code: string }>(
    "SELECT participant_code FROM identity.participants WHERE study = $1 AND upn = $2 AND participant_code <> $3",
    [input.study, input.upn, input.participantCode],
  );
  if (clash.rows[0]) {
    // One UPN, one pupil. Refused here rather than found in an analysis.
    return { linked: false, conflict: `that UPN is already linked to ${clash.rows[0].participant_code}` };
  }

  const result = await db.query(
    `UPDATE identity.participants
        SET upn = $3, upn_source = $4, upn_linked_at = now(), upn_linked_by = $5
      WHERE study = $1 AND participant_code = $2`,
    [input.study, input.participantCode, input.upn, input.source, actor],
  );
  return { linked: result.rowCount > 0 };
}

/**
 * Record that two codes are the same person.
 *
 * Nothing is rewritten. The correction is stored, and the dataset is derived
 * through it next time it is built — so this is reversible by withdrawing the
 * row, and the event log continues to say what the participant actually typed.
 */
export async function recordCorrection(
  db: Db,
  actor: string,
  input: z.infer<typeof correctionShape>,
): Promise<{ recorded: boolean; error?: string }> {
  if (input.wrongCode === input.rightCode) return { recorded: false, error: "those are the same code" };

  // Refuse a correction that would point at a code which is itself corrected
  // away: chains are resolvable, but a two-step join made by accident is not
  // something to discover later.
  const onward = await db.query<{ right_code: string }>(
    "SELECT right_code FROM research.code_corrections WHERE study = $1 AND wrong_code = $2 AND withdrawn_at IS NULL",
    [input.study, input.rightCode],
  );
  if (onward.rows[0]) {
    return { recorded: false, error: `${input.rightCode} is itself corrected to ${onward.rows[0].right_code} — correct to that instead` };
  }

  await db.query(
    `INSERT INTO research.code_corrections (study, wrong_code, right_code, reason, made_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [input.study, input.wrongCode, input.rightCode, input.reason, actor],
  );
  await audit(db, {
    actor,
    action: "code.corrected",
    study: input.study,
    subject: input.wrongCode,
    detail: { rightCode: input.rightCode, reason: input.reason },
  });
  return { recorded: true };
}

export async function withdrawCorrection(db: Db, actor: string, study: string, correctionId: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE research.code_corrections
        SET withdrawn_at = now(), withdrawn_by = $3
      WHERE correction_id = $2 AND study = $1 AND withdrawn_at IS NULL`,
    [study, correctionId, actor],
  );
  await audit(db, { actor, action: "code.correction_withdrawn", study, subject: String(correctionId) });
  return result.rowCount > 0;
}

/** Live corrections, in the shape `ingest` takes them. */
export async function aliasesFor(db: Db, study: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ wrong_code: string; right_code: string }>(
    "SELECT wrong_code, right_code FROM research.code_corrections WHERE study = $1 AND withdrawn_at IS NULL",
    [study],
  );
  return Object.fromEntries(rows.map((r) => [r.wrong_code, r.right_code]));
}

/** Write the identity partition ingest kept separate, plus the claim record. */
export async function storeIdentity(
  db: Db,
  study: string,
  rows: { participantId: string; sessionId: string; variable: string; value: string; recordedAt: string }[],
): Promise<number> {
  const bySession = new Map<string, { participantId: string; recordedAt: string; values: Record<string, string> }>();
  for (const row of rows) {
    const entry = bySession.get(row.sessionId) ?? {
      participantId: row.participantId,
      recordedAt: row.recordedAt,
      values: {},
    };
    entry.values[row.variable] = row.value;
    bySession.set(row.sessionId, entry);
  }

  let written = 0;
  for (const [sessionId, entry] of bySession) {
    const given = entry.values["first_name"] ?? null;
    const family = entry.values["last_name"] ?? null;
    const dob = entry.values["dob"] ?? null;
    const address = parseHomeAddress(entry.values["home_address"]);
    const addressJson = address ? JSON.stringify(address) : null;

    await db.query(
      `INSERT INTO identity.code_claims (study, session_id, claimed_code, given_name, family_name, date_of_birth, home_address, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (session_id) DO NOTHING`,
      [study, sessionId, entry.participantId, given, family, dob, addressJson, entry.recordedAt],
    );

    // The registry keeps the first name given for a code and does not
    // overwrite it: a later wave with a different spelling is evidence to look
    // at, not a reason to quietly replace what is on file. An address is the
    // opposite — people move — so it holds the one from the most recent sitting,
    // judged by when the sitting happened, not by when it arrived.
    await db.query(
      `INSERT INTO identity.participants
         (participant_code, study, given_name, family_name, date_of_birth, home_address, home_address_recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE $7::timestamptz END)
       ON CONFLICT (participant_code) DO UPDATE SET
         given_name = COALESCE(identity.participants.given_name, EXCLUDED.given_name),
         family_name = COALESCE(identity.participants.family_name, EXCLUDED.family_name),
         date_of_birth = COALESCE(identity.participants.date_of_birth, EXCLUDED.date_of_birth),
         home_address = CASE
           WHEN EXCLUDED.home_address IS NOT NULL
            AND (identity.participants.home_address_recorded_at IS NULL
                 OR EXCLUDED.home_address_recorded_at >= identity.participants.home_address_recorded_at)
           THEN EXCLUDED.home_address ELSE identity.participants.home_address END,
         home_address_recorded_at = CASE
           WHEN EXCLUDED.home_address IS NOT NULL
            AND (identity.participants.home_address_recorded_at IS NULL
                 OR EXCLUDED.home_address_recorded_at >= identity.participants.home_address_recorded_at)
           THEN EXCLUDED.home_address_recorded_at ELSE identity.participants.home_address_recorded_at END`,
      [entry.participantId, study, given, family, dob, addressJson, entry.recordedAt],
    );
    written += 1;
  }
  return written;
}
