import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import { STUDY, auth, research } from "./apps.js";

/**
 * Administration: who may use the platform, and which iPads may post to it.
 *
 * Both live here rather than in security rules because both mint credentials,
 * and minting a credential is not something a browser should be able to do
 * however trusted the person holding it. The rules refuse every client write to
 * `devices`; this is the only path that creates one.
 */

const ROLES = ["owner", "researcher", "analyst"] as const;
type Role = (typeof ROLES)[number];

/** Every call here is owner-only, and says so the same way. */
function requireOwner(request: CallableRequest): string {
  const token = request.auth?.token as { role?: string; device?: boolean } | undefined;
  if (!request.auth) throw new HttpsError("unauthenticated", "sign in first");
  if (token?.device) throw new HttpsError("permission-denied", "devices cannot administer the study");
  if (token?.role !== "owner") {
    throw new HttpsError("permission-denied", "only an owner can do this");
  }
  return request.auth.uid;
}

async function audit(actor: string, action: string, subject: string, detail: unknown): Promise<void> {
  await research().collection(paths.audit(STUDY)).add({
    at: FieldValue.serverTimestamp(),
    actor,
    action,
    subject,
    detail: detail ?? null,
  });
}

/**
 * Enrol an iPad.
 *
 * The device becomes an authenticated identity in its own right, with a
 * `device` claim that every security rule keys off. It gets a custom token,
 * which the iPad exchanges once for a session the SDK then keeps refreshed —
 * so the token in the researcher's hands is short-lived and the device does not
 * hold a long-lived secret that a lost iPad would surrender.
 */
export const enrolDevice = onCall(async (request) => {
  const actor = requireOwner(request);
  const { label } = (request.data ?? {}) as { label?: string };
  if (!label || label.trim().length === 0) {
    throw new HttpsError("invalid-argument", "give the iPad a label you will recognise on a table of six");
  }

  const deviceId = `dev_${research().collection("_").doc().id}`;
  await auth().createUser({ uid: deviceId, displayName: label });
  await auth().setCustomUserClaims(deviceId, { device: true, study: STUDY });
  await research().doc(paths.device(STUDY, deviceId)).set({
    deviceId,
    label,
    study: STUDY,
    enrolledBy: actor,
    enrolledAt: FieldValue.serverTimestamp(),
    revokedAt: null,
  });
  await audit(actor, "device.enrolled", deviceId, { label });

  const token = await auth().createCustomToken(deviceId, { device: true, study: STUDY });
  logger.info("device enrolled", { deviceId, label });
  return { deviceId, label, token };
});

/**
 * Revoke an iPad.
 *
 * Disabling the account stops new sessions; revoking refresh tokens stops the
 * one it already holds, which is what makes this useful for a device that has
 * gone missing rather than one handed back.
 */
export const revokeDevice = onCall(async (request) => {
  const actor = requireOwner(request);
  const { deviceId } = (request.data ?? {}) as { deviceId?: string };
  if (!deviceId) throw new HttpsError("invalid-argument", "deviceId is required");

  await auth().updateUser(deviceId, { disabled: true });
  await auth().revokeRefreshTokens(deviceId);
  await research().doc(paths.device(STUDY, deviceId)).update({ revokedAt: FieldValue.serverTimestamp() });
  await audit(actor, "device.revoked", deviceId, null);
  return { deviceId, revoked: true };
});

/**
 * Give somebody a role, or take it away.
 *
 * This is the whole of user administration: an account with no role is
 * authenticated and authorised for nothing, and passing `null` returns it to
 * that state. Claims reach the client on their next token refresh, so a
 * revocation takes effect within the hour without anybody signing out.
 */
export const setRole = onCall(async (request) => {
  const actor = requireOwner(request);
  const { email, role } = (request.data ?? {}) as { email?: string; role?: Role | null };
  if (!email) throw new HttpsError("invalid-argument", "email is required");
  if (role !== null && !ROLES.includes(role as Role)) {
    throw new HttpsError("invalid-argument", `role must be one of ${ROLES.join(", ")}, or null to remove it`);
  }

  const user = await auth().getUserByEmail(email);
  if ((user.customClaims as { device?: boolean } | undefined)?.device) {
    throw new HttpsError("failed-precondition", "that account is an enrolled device, not a person");
  }
  // An owner removing their own last role would lock the study out of its own
  // administration, so it is refused rather than confirmed.
  if (user.uid === actor && role !== "owner") {
    throw new HttpsError("failed-precondition", "you cannot remove your own owner role — ask another owner");
  }

  await auth().setCustomUserClaims(user.uid, role === null ? {} : { role });
  await auth().revokeRefreshTokens(user.uid);
  await audit(actor, "role.set", user.uid, { email, role });
  return { uid: user.uid, email, role };
});

/** Everyone who can sign in, and what they may do. */
export const listPeople = onCall(async (request) => {
  requireOwner(request);
  const users = await auth().listUsers(1000);
  return {
    people: users.users
      .filter((u) => !(u.customClaims as { device?: boolean } | undefined)?.device)
      .map((u) => ({
        uid: u.uid,
        email: u.email ?? null,
        displayName: u.displayName ?? null,
        role: ((u.customClaims as { role?: string } | undefined)?.role ?? null) as Role | null,
        lastSignIn: u.metadata.lastSignInTime ?? null,
      })),
  };
});
