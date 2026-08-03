import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { joinSession, paths, type SessionDoc } from "@myself/firebase";
import { ingest } from "@myself/store";
import { STUDY, identity, research } from "./apps.js";
import { releasesByHash } from "./releases.js";

/**
 * The identity side: names in, names out, both under control.
 *
 * IN — a trigger. When a sitting lands, this derives the identity partition
 * from it and writes it to the identity project. Doing it server-side means a
 * child's name never passes through a researcher's browser on the way to
 * storage, which is a materially better position than the file-based route it
 * replaces.
 *
 * OUT — callables, owner-only, each of which writes the access log BEFORE it
 * reads anything. A log written only on success is a log of successes; the
 * lookups worth reviewing later include the ones that found nothing.
 */

function requireOwner(request: CallableRequest): string {
  const token = request.auth?.token as { role?: string; device?: boolean } | undefined;
  if (!request.auth) throw new HttpsError("unauthenticated", "sign in first");
  if (token?.device) throw new HttpsError("permission-denied", "devices cannot read identifiers");
  if (token?.role !== "owner") throw new HttpsError("permission-denied", "only an owner can read identifiers");
  return request.auth.uid;
}

function requireJustification(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 12) {
    throw new HttpsError(
      "invalid-argument",
      "say why this lookup is needed — it is recorded against your name",
    );
  }
  return text;
}

async function logAccess(actor: string, action: string, subject: string, justification: string): Promise<void> {
  await identity().collection(paths.accessLog(STUDY)).add({
    at: FieldValue.serverTimestamp(),
    actor,
    action,
    participant: subject,
    justification,
  });
}

/**
 * Derive and file the identity partition for a sitting that has just arrived.
 *
 * Runs on write rather than create, because a sitting is finished by a second
 * write when a participant resumes, and the name may only be present then.
 */
export const captureIdentity = onDocumentWritten("studies/{study}/sessions/{sessionId}", async (event) => {
  const after = event.data?.after?.data() as SessionDoc | undefined;
  if (!after) return;

  const manifest = releasesByHash.get(after.releaseHash);
  if (!manifest) {
    // Better to leave the identity record absent and say so than to read the
    // answers through the wrong instrument and file a name against the wrong
    // variable.
    logger.warn("no manifest for release; identity not captured", {
      sessionId: after.sessionId,
      releaseHash: after.releaseHash,
    });
    return;
  }

  const chunks =
    after.chunkCount > 0
      ? (await research().collection(paths.sessionChunks(after.study, after.sessionId)).get()).docs.map(
          (d) => d.data() as { sessionId: string; index: number; events: never[] },
        )
      : [];

  const { identity: rows } = ingest([joinSession(after, chunks)], {
    manifest,
    study: after.study,
  });
  if (rows.length === 0) return;

  const values: Record<string, string> = {};
  for (const row of rows) values[row.variable] = row.value;
  const code = rows[0]!.participantId;
  const db = identity();

  // The claim is what was typed at this sitting, kept whatever else happens:
  // it is the evidence a twin split or a mistyped-code correction rests on.
  await db.doc(paths.claim(after.study, after.sessionId)).set({
    study: after.study,
    sessionId: after.sessionId,
    claimedCode: code,
    givenName: values["first_name"] ?? null,
    familyName: values["last_name"] ?? null,
    dateOfBirth: values["dob"] ?? null,
    recordedAt: after.startedAt,
  });

  // The registry keeps the first name given for a code. A later wave spelling
  // it differently is evidence to look at, not a reason to overwrite the
  // record — which is why this merges rather than replaces.
  const ref = db.doc(paths.participant(after.study, code));
  const existing = await ref.get();
  const before = (existing.data() ?? {}) as Record<string, unknown>;
  await ref.set(
    {
      participantCode: code,
      study: after.study,
      givenName: before["givenName"] ?? values["first_name"] ?? null,
      familyName: before["familyName"] ?? values["last_name"] ?? null,
      dateOfBirth: before["dateOfBirth"] ?? values["dob"] ?? null,
      upn: before["upn"] ?? null,
      nhsNumber: before["nhsNumber"] ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
});

/** Code -> person. */
export const lookupParticipant = onCall(async (request) => {
  const actor = requireOwner(request);
  const { participantCode } = (request.data ?? {}) as { participantCode?: string };
  const why = requireJustification((request.data as { justification?: string })?.justification);
  if (!participantCode) throw new HttpsError("invalid-argument", "participantCode is required");

  await logAccess(actor, "identity.lookup", participantCode, why);
  const snap = await identity().doc(paths.participant(STUDY, participantCode)).get();
  if (!snap.exists) throw new HttpsError("not-found", "no registry entry for that code");
  return snap.data();
});

/**
 * Person -> every code they have used.
 *
 * Searches the claims as well as the registry, because the sitting worth
 * finding is the one filed under a code nobody expected.
 */
export const searchParticipants = onCall(async (request) => {
  const actor = requireOwner(request);
  const { familyName, givenName, upn } = (request.data ?? {}) as {
    familyName?: string;
    givenName?: string;
    upn?: string;
  };
  const why = requireJustification((request.data as { justification?: string })?.justification);
  await logAccess(actor, "identity.search", upn ?? `${givenName ?? ""} ${familyName ?? ""}`.trim(), why);

  const db = identity();
  const hits = new Map<string, { participantCode: string; matchedOn: string }>();

  if (upn) {
    const byUpn = await db.collection(paths.participants(STUDY)).where("upn", "==", upn).get();
    for (const d of byUpn.docs) hits.set(d.id, { participantCode: d.id, matchedOn: "upn" });
  }
  if (familyName) {
    const claims = await db
      .collection(paths.claims(STUDY))
      .where("familyName", "==", familyName)
      .get();
    for (const d of claims.docs) {
      const data = d.data() as { claimedCode: string; givenName?: string };
      if (givenName && data.givenName !== givenName) continue;
      hits.set(data.claimedCode, { participantCode: data.claimedCode, matchedOn: "claimed-name" });
    }
  }
  return { hits: [...hits.values()] };
});

/** Attach an identifier a school or parent provided. */
export const linkIdentifier = onCall(async (request) => {
  const actor = requireOwner(request);
  const { participantCode, upn, nhsNumber, source } = (request.data ?? {}) as {
    participantCode?: string;
    upn?: string;
    nhsNumber?: string;
    source?: string;
  };
  const why = requireJustification((request.data as { justification?: string })?.justification);
  if (!participantCode) throw new HttpsError("invalid-argument", "participantCode is required");
  if (!upn && !nhsNumber) throw new HttpsError("invalid-argument", "give a UPN or an NHS number");

  await logAccess(actor, "identity.link", participantCode, why);
  const db = identity();

  // One identifier, one pupil. A clash means somebody has been given another
  // child's number, which is worth stopping at the point of entry rather than
  // finding in a linked extract.
  for (const [field, value] of [
    ["upn", upn],
    ["nhsNumber", nhsNumber],
  ] as const) {
    if (!value) continue;
    const clash = await db.collection(paths.participants(STUDY)).where(field, "==", value).get();
    const other = clash.docs.find((d) => d.id !== participantCode);
    if (other) throw new HttpsError("already-exists", `that ${field} is already linked to ${other.id}`);
  }

  await db.doc(paths.participant(STUDY, participantCode)).set(
    {
      ...(upn ? { upn, upnSource: source ?? null, upnLinkedAt: FieldValue.serverTimestamp(), upnLinkedBy: actor } : {}),
      ...(nhsNumber
        ? { nhsNumber, nhsSource: source ?? null, nhsLinkedAt: FieldValue.serverTimestamp(), nhsLinkedBy: actor }
        : {}),
    },
    { merge: true },
  );
  return { participantCode, linked: true };
});

/** Parents and children, twins with each other. Recorded both ways. */
export const recordRelationship = onCall(async (request) => {
  const actor = requireOwner(request);
  const { participantCode, relatedCode, kind, note } = (request.data ?? {}) as {
    participantCode?: string;
    relatedCode?: string;
    kind?: "parent_of" | "child_of" | "sibling_of" | "twin_of";
    note?: string;
  };
  const why = requireJustification((request.data as { justification?: string })?.justification);
  if (!participantCode || !relatedCode || !kind) {
    throw new HttpsError("invalid-argument", "participantCode, relatedCode and kind are required");
  }
  if (participantCode === relatedCode) {
    throw new HttpsError("invalid-argument", "a person cannot be related to themselves");
  }

  await logAccess(actor, "identity.relationship", `${participantCode} ${kind} ${relatedCode}`, why);
  const inverse = { parent_of: "child_of", child_of: "parent_of", sibling_of: "sibling_of", twin_of: "twin_of" } as const;
  const db = identity();
  const at = FieldValue.serverTimestamp();
  // Both directions, because a relationship readable only one way is one
  // somebody will miss when they look from the other end.
  await db.collection(paths.relationships(STUDY)).add({ participantCode, relatedCode, kind, note: note ?? null, recordedBy: actor, recordedAt: at });
  await db.collection(paths.relationships(STUDY)).add({
    participantCode: relatedCode,
    relatedCode: participantCode,
    kind: inverse[kind],
    note: note ?? null,
    recordedBy: actor,
    recordedAt: at,
  });
  return { recorded: true };
});
