import type { Firestore } from "firebase-admin/firestore";
import type { CallableRequest } from "firebase-functions/v2/https";
import { paths } from "@myself/firebase";
import { atLeast, STUDIO_ROLES, type SessionResponse, type StudioRole } from "@myself/studio";
import { STUDY, research } from "../apps.js";
import { refuse } from "./errors.js";

/**
 * Who may do what in MySelf Studio, decided on the server (docs/16 §5.7).
 *
 * THE SAME ANSWER AS THE RULES, TO THE LETTER. `studioLevel` in
 * infra/firebase/firestore.rules decides what a browser may read and save;
 * this decides what a function will publish, restore, roll back or grant. If
 * the two ever disagreed, somebody the rules refuse could still publish to
 * children, or somebody the rules admit would be refused for no reason they
 * could see. So each step below is the rules' step, in the rules' order, and
 * the unit tests put the rules suite's own callers through it.
 *
 * READ EVERY TIME, never cached. A revocation has to bite on the very next
 * call, not when a cache or a token expires: the whole point of keeping roles
 * in documents rather than in claims (see the rules' header) is that removing
 * somebody is immediate.
 */

/** The parts of a decoded ID token this reads. Anything else in it is ignored. */
export interface StudioToken {
  device?: unknown;
  role?: unknown;
  email?: unknown;
  email_verified?: unknown;
  firebase?: unknown;
}

export interface StudioAccess {
  role: StudioRole | null;
  /** The caller's list key (lower-cased address), when the token carries one. */
  email: string | null;
  /** Why there is no role; null when there is one. */
  reason: SessionResponse["reason"];
}

function isRole(value: unknown): value is StudioRole {
  return typeof value === "string" && (STUDIO_ROLES as readonly string[]).includes(value);
}

/**
 * A Firestore map, as the rules' `is map` sees one: a plain object. An array,
 * a string or a Timestamp is not, so a malformed domain rule admits nobody.
 */
function isMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Whether a string can be one Firestore document ID: no slash, not "." or "..",
 * not a reserved `__name__`, and within the size limit. Deliberately no more
 * than that — any stricter and a verified address the rules admit could be
 * refused here.
 */
function isDocumentId(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 1500 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function providerOf(token: StudioToken): unknown {
  return isMap(token.firebase) ? token.firebase["sign_in_provider"] : undefined;
}

/**
 * The caller's Studio role, mirroring `studioLevel(study)`:
 *
 * 1. an iPad (`device` claim) is nobody, whatever else its token says;
 * 2. an `owner` role claim is an admin, list or no list — the one claim the
 *    Studio honours, so there is always somebody who can add the first member;
 * 3. otherwise only a Google sign-in with an address Google verified counts;
 * 4. then the person's own entry decides, if there is one — even when it gives
 *    less than a domain rule would, and even when its role is not a role (which
 *    is nothing, not a fall-through to the domain);
 * 5. otherwise a domain rule for exactly the part after the only "@";
 * 6. otherwise nothing.
 */
export async function studioRoleFor(db: Firestore, study: string, token: StudioToken | null | undefined): Promise<StudioAccess> {
  if (!token) return { role: null, email: null, reason: "not_signed_in" };
  const rawEmail = typeof token.email === "string" ? token.email : null;
  const key = rawEmail === null ? null : rawEmail.toLowerCase();

  if (token.device === true) return { role: null, email: null, reason: "not_google" };
  if (token.role === "owner") return { role: "admin", email: key, reason: null };
  if (providerOf(token) !== "google.com") return { role: null, email: key, reason: "not_google" };
  if (token.email_verified !== true) return { role: null, email: key, reason: "email_not_verified" };
  if (key === null) return { role: null, email: null, reason: "not_google" };

  // An address that could not be a document ID cannot be on the list, and
  // building a path from it could name a different document entirely. Google
  // never verifies such an address; refusing is the safe reading of one.
  if (!isDocumentId(key)) return { role: null, email: key, reason: "not_listed" };

  // Not `paths.studioMember`, which also trims: the rules look up the address
  // exactly as lower-cased, and so must this.
  const member = await db.doc(`${paths.studioMembers(study)}/${key}`).get();
  if (member.exists) {
    const role = member.get("role");
    return isRole(role) ? { role, email: key, reason: null } : { role: null, email: key, reason: "not_listed" };
  }

  const parts = key.split("@");
  if (parts.length === 2) {
    const config = await db.doc(paths.studioAccessConfig(study)).get();
    const domains: unknown = config.exists ? config.get("domains") : {};
    if (isMap(domains) && Object.prototype.hasOwnProperty.call(domains, parts[1]!)) {
      const role = domains[parts[1]!];
      if (isRole(role)) return { role, email: key, reason: null };
    }
  }
  return { role: null, email: key, reason: "not_listed" };
}

/** Who is acting, as every Studio write records them. */
export interface StudioActor {
  uid: string;
  /** The list key (lower-cased address), or null for an owner whose token has none. */
  email: string | null;
  role: StudioRole;
  /** Holds the `owner` claim: may change their own list entry (see setMember). */
  owner: boolean;
}

const REASON_MESSAGES: Record<NonNullable<SessionResponse["reason"]>, string> = {
  not_signed_in: "Sign in with your Google account to use MySelf Studio.",
  not_google: "MySelf Studio only accepts a Google sign-in. Sign out, then sign in with Google.",
  email_not_verified: "Google hasn't confirmed that this email address belongs to this account, so MySelf Studio can't use it.",
  not_listed: "This Google account isn't on the MySelf Studio list. Ask a Studio admin to add you.",
};

const ROLE_NAMES: Record<StudioRole, string> = { viewer: "viewer", editor: "editor", publisher: "publisher", admin: "admin" };

/**
 * The caller, if the list gives them at least `needed`; otherwise the refusal
 * the editor shows. Re-reads the list on every call.
 */
export async function requireStudio(
  request: Pick<CallableRequest, "auth">,
  needed: StudioRole,
  env: { db: Firestore; study: string } = { db: research(), study: STUDY },
): Promise<StudioActor> {
  if (!request.auth) throw refuse.unauthenticated(needed);
  const token = request.auth.token as StudioToken;
  const access = await studioRoleFor(env.db, env.study, token);
  if (!access.role) throw refuse.forbidden(needed, REASON_MESSAGES[access.reason ?? "not_listed"]);
  if (!atLeast(access.role, needed)) {
    throw refuse.forbidden(
      needed,
      `This needs a Studio ${ROLE_NAMES[needed]} or above, and your role is ${ROLE_NAMES[access.role]}. Ask a Studio admin if you need more.`,
    );
  }
  return { uid: request.auth.uid, email: access.email, role: access.role, owner: token.role === "owner" && token.device !== true };
}
