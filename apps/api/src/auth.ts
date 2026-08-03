import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Db } from "./db/index.js";

/**
 * Who is allowed to do what.
 *
 * Two entirely different callers reach this server and they authenticate in
 * entirely different ways:
 *
 *   - People sign in through an OIDC provider you administer (Keycloak in the
 *     shipped stack). Their roles arrive in the token. Nobody is created here,
 *     which is the point: adding and removing admins happens in one place, in a
 *     console, and takes effect on the next token.
 *   - iPads carry an enrolment token issued once by an admin. They can post
 *     sittings and do nothing else — a stolen device cannot read the study.
 *
 * Participants never authenticate at all.
 */

export const ROLES = ["owner", "researcher", "analyst"] as const;
export type Role = (typeof ROLES)[number];

/**
 * What each role may do. Deliberately short, and deliberately explicit about
 * the two dangerous ones: only an owner can enrol a device or read a name, and
 * reading a name is logged with a justification whoever asks.
 */
export const CAPABILITIES = {
  owner: ["read", "import", "export", "enrol_devices", "manage_people", "read_identifiers", "resolve_quarantine"],
  researcher: ["read", "import", "export", "resolve_quarantine"],
  analyst: ["read"],
} as const satisfies Record<Role, readonly string[]>;

export type Capability = (typeof CAPABILITIES)[Role][number];

export interface Person {
  subject: string;
  email: string | null;
  name: string | null;
  roles: Role[];
}

export function can(person: Person, capability: Capability): boolean {
  return person.roles.some((role) => (CAPABILITIES[role] as readonly string[]).includes(capability));
}

export interface AuthConfig {
  /** OIDC issuer, e.g. https://auth.example.org/realms/myself */
  issuer: string;
  audience: string;
  /**
   * Local-only escape hatch for development. Refuses to switch on when
   * NODE_ENV is production — an unauthenticated server holding children's
   * answers is not a mode worth having available by mistake.
   */
  devBypass?: boolean;
}

const roleOf = (value: unknown): Role | null =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;

/** Roles as Keycloak presents them, from realm roles or a `roles` claim. */
export function rolesFromClaims(claims: Record<string, unknown>): Role[] {
  const realm = claims["realm_access"] as { roles?: unknown[] } | undefined;
  const raw = [...(realm?.roles ?? []), ...((claims["roles"] as unknown[]) ?? [])];
  const roles = raw
    .map((r) => (typeof r === "string" ? r.replace(/^myself-/, "") : r))
    .map(roleOf)
    .filter((r): r is Role => r !== null);
  return [...new Set(roles)];
}

export class Authenticator {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private config: AuthConfig) {
    if (config.devBypass && process.env["NODE_ENV"] === "production") {
      throw new Error("MYSELF_DEV_AUTH cannot be enabled in production");
    }
  }

  private keys() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(`${this.config.issuer}/protocol/openid-connect/certs`));
    }
    return this.jwks;
  }

  /** Verify a bearer token and return the person, or null if it is not valid. */
  async person(authorization: string | undefined): Promise<Person | null> {
    const token = bearer(authorization);
    if (!token) return null;

    if (this.config.devBypass) {
      // Shape: "dev:<subject>:<role>[,<role>]". Only reachable outside production.
      if (!token.startsWith("dev:")) return null;
      const [, subject = "dev", roles = "owner"] = token.split(":");
      return {
        subject,
        email: `${subject}@localhost`,
        name: subject,
        roles: roles.split(",").map(roleOf).filter((r): r is Role => r !== null),
      };
    }

    try {
      const { payload } = await jwtVerify(token, this.keys(), {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      const roles = rolesFromClaims(payload as Record<string, unknown>);
      // A signed-in person with no role is authenticated but not authorised.
      // They get a clear 403 rather than a confusing empty study.
      return {
        subject: String(payload.sub ?? ""),
        email: typeof payload["email"] === "string" ? payload["email"] : null,
        name: typeof payload["name"] === "string" ? payload["name"] : null,
        roles,
      };
    } catch {
      return null;
    }
  }
}

const bearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
};

// ── Device tokens ─────────────────────────────────────────────────────────

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A fresh enrolment token. Shown once, at enrolment, and never recoverable. */
export function mintDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export interface Device {
  deviceId: string;
  label: string;
  study: string;
}

/** Resolve a device from its bearer token, rejecting revoked enrolments. */
export async function deviceFor(db: Db, authorization: string | undefined): Promise<Device | null> {
  const token = bearer(authorization);
  if (!token) return null;
  const hash = hashToken(token);
  const { rows } = await db.query<{ device_id: string; label: string; study: string; token_hash: string }>(
    "SELECT device_id, label, study, token_hash FROM research.devices WHERE token_hash = $1 AND revoked_at IS NULL",
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // Constant-time even though the lookup was by hash: the comparison is cheap
  // and the habit is what stops a timing leak being introduced later.
  const a = Buffer.from(row.token_hash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await db.query("UPDATE research.devices SET last_seen_at = now() WHERE device_id = $1", [row.device_id]);
  return { deviceId: row.device_id, label: row.label, study: row.study };
}

/** Append-only record of anything worth explaining afterwards. */
export async function audit(
  db: Db,
  entry: { actor: string; action: string; study?: string; subject?: string; detail?: unknown },
): Promise<void> {
  await db.query(
    "INSERT INTO research.audit (actor, action, study, subject, detail) VALUES ($1, $2, $3, $4, $5)",
    [
      entry.actor,
      entry.action,
      entry.study ?? null,
      entry.subject ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ],
  );
}
