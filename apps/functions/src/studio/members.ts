import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import { atLeast, STUDIO_ROLES, type SetDomainResponse, type SetMemberResponse, type StudioRole } from "@myself/studio";
import { listedRole } from "./access.js";
import { auditRow, newAuditRef, type AuditActor } from "./audit.js";
import { isConsumerDomain } from "./domains.js";
import { problem, refuse } from "./errors.js";

/**
 * Who is on the Studio list (docs/16 §5.7).
 *
 * The list is two things: a document per person, keyed by the lower-cased
 * address Google verified, and an optional domain rule. Only functions write
 * either — the rules refuse every browser, admins included — and every change
 * is audited in the same transaction. A change bites on the person's very next
 * request, because the rules and `requireStudio` read the list every time.
 */

export interface SetMemberArgs {
  study: string;
  /** Already normalised: trimmed and lower-cased (`emailKey`). */
  email: string;
  role: StudioRole | null;
  /** Omitted keeps the note already there; null clears it. */
  note?: string | null;
  actor: AuditActor & { owner: boolean };
}

function isRole(value: unknown): value is StudioRole {
  return typeof value === "string" && (STUDIO_ROLES as readonly string[]).includes(value);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * The actor is still an admin, read INSIDE the transaction that changes the
 * list.
 *
 * `requireStudio` checked them a moment earlier, outside it — enough for
 * everything else, but not for a change to the list itself. Two admins who
 * each remove the other at the same instant would both pass that check, both
 * transactions would touch only the other's entry, and both would commit:
 * each refusal of a self-change holds on its own, and together they leave the
 * Studio with no admin (write skew). Reading one's own entry (and the domain
 * rule) here puts those documents in the transaction, so the second of two
 * such changes is retried against the first's result and refused. The owner's
 * access is the claim, not the list, so there is nothing of theirs to read.
 */
async function assertStillAdmin(tx: Transaction, db: Firestore, study: string, actor: AuditActor & { owner: boolean }): Promise<void> {
  if (actor.owner) return;
  const role = actor.email === null ? null : await listedRole((path) => tx.get(db.doc(path)), study, actor.email);
  if (!atLeast(role, "admin")) {
    throw refuse.forbidden(
      "admin",
      "Your own Studio access changed while this was being saved, and you are no longer an admin, so nothing was changed.",
    );
  }
}

/**
 * Give somebody a role, change it, or take them off the list.
 *
 * Nobody may change or remove their OWN entry, unless they hold the owner
 * claim. An admin demoting themselves by a slip of the dropdown — or the last
 * admin removing themselves — would lock the study out of its own Studio with
 * nobody left who could undo it from the page. Another admin can make the
 * change; the owner, whose access does not depend on the list, always can.
 */
export async function setMember(db: Firestore, args: SetMemberArgs): Promise<SetMemberResponse> {
  const { study, email, role, actor } = args;
  if (!actor.owner && actor.email !== null && actor.email === email) {
    throw refuse.invalid(
      "You can't change or remove your own access, so the Studio can never be left without an admin by accident. Ask another admin to do it.",
      [problem("access.own_entry", "Your own entry on the Studio list can only be changed by another admin.", { kind: "survey", field: "email" })],
    );
  }
  const ref = db.doc(paths.studioMember(study, email));

  return db.runTransaction(async (tx) => {
    await assertStillAdmin(tx, db, study, actor);
    const snap = await tx.get(ref);
    const previousRole = snap.exists ? ((snap.get("role") as unknown) ?? null) : null;
    if (role === null) {
      // Already off the list: nothing changed, so nothing to record.
      if (!snap.exists) return { email, role: null };
      tx.delete(ref);
      tx.create(newAuditRef(db, study), auditRow("access.member_removed", actor, null, email, { previousRole }));
      return { email, role: null };
    }
    const note = args.note === undefined ? ((snap.exists ? snap.get("note") : null) ?? null) : args.note;
    tx.set(ref, {
      email,
      role,
      addedAt: FieldValue.serverTimestamp(),
      addedBy: actor.uid,
      addedByEmail: actor.email,
      note,
    });
    tx.create(newAuditRef(db, study), auditRow("access.member_set", actor, null, email, { role, previousRole, note }));
    return { email, role };
  });
}

export interface SetDomainArgs {
  study: string;
  /** Already normalised: trimmed, lower-cased, no leading "@" (`domainKey`). */
  domain: string;
  role: StudioRole | null;
  actor: AuditActor & { owner: boolean };
}

/** The domain rules that admit anybody: entries whose role is a role. */
function validRules(domains: Record<string, unknown>): Record<string, StudioRole> {
  const out: Record<string, StudioRole> = {};
  for (const [domain, role] of Object.entries(domains)) if (isRole(role)) out[domain] = role;
  return out;
}

/**
 * Admit every verified Google account at a domain with a role, or stop.
 *
 * Refused for a public mail provider, where "everyone at the domain" is
 * everyone. Also refused when it would take away the admin access of the very
 * person making the change — somebody who is an admin only through this rule —
 * for the same reason nobody may demote their own entry.
 */
export async function setDomain(db: Firestore, args: SetDomainArgs): Promise<SetDomainResponse> {
  const { study, domain, role, actor } = args;
  if (role !== null && isConsumerDomain(domain)) {
    throw refuse.invalid(
      `${domain} is a public mail provider: anyone can create an account there, so it can't be used as a rule. Add people individually instead.`,
      [problem("access.consumer_domain", `${domain} is a public mail provider.`, { kind: "survey", field: "domain" })],
      [],
      "invalid-argument",
    );
  }
  const configRef = db.doc(paths.studioAccessConfig(study));
  const actorDomain = actor.email?.split("@");
  const ownDomain = !actor.owner && actorDomain?.length === 2 && actorDomain[1] === domain;

  return db.runTransaction(async (tx) => {
    await assertStillAdmin(tx, db, study, actor);
    const config = await tx.get(configRef);
    if (ownDomain && !atLeast(role, "admin")) {
      const own = await tx.get(db.doc(paths.studioMember(study, actor.email!)));
      if (!own.exists) {
        throw refuse.invalid(
          `Your own admin access comes from the rule for ${domain}, so you can't lower or remove it yourself. Ask another admin, or have someone add you to the list by name first.`,
          [problem("access.own_domain", `Your access comes from the rule for ${domain}.`, { kind: "survey", field: "domain" })],
        );
      }
    }
    const stored: unknown = config.exists ? config.get("domains") : undefined;
    // A malformed rule admits nobody (as the rules read it); it is replaced
    // rather than merged into.
    const domains: Record<string, unknown> = isMap(stored) ? { ...stored } : {};
    const previousRole = Object.prototype.hasOwnProperty.call(domains, domain) ? (domains[domain] ?? null) : null;
    if (role === null) delete domains[domain];
    else domains[domain] = role;
    tx.set(configRef, { domains, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    tx.create(newAuditRef(db, study), auditRow("access.domain_set", actor, null, domain, { role, previousRole }));
    return { domains: validRules(domains) };
  });
}
