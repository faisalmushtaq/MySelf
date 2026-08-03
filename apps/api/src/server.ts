import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Authenticator,
  CAPABILITIES,
  ROLES,
  audit,
  can,
  deviceFor,
  mintDeviceToken,
  type Capability,
  type Person,
} from "./auth.js";
import { migrate, type Db } from "./db/index.js";
import { createPostgres } from "./db/postgres.js";
import {
  aliasesFor,
  correctionShape,
  linkUpn,
  lookupByCode,
  lookupShape,
  recordCorrection,
  searchByPerson,
  searchShape,
  upnShape,
  withdrawCorrection,
} from "./routes/identity.js";
import { batchShape, ingestBatch, storedSessions } from "./routes/sync.js";

/**
 * The MySelf API.
 *
 * Small on purpose. It stores raw event logs, hands them back, and enforces who
 * may do which of those things. Everything derived — participants, waves,
 * scores, the BIDS folder — is computed by `@myself/store`, the same code the
 * researcher view runs in the browser, so a screen and an export cannot
 * disagree about what the data says (D-35).
 */

export interface ServerOptions {
  db: Db;
  auth: Authenticator;
  /** Origins allowed to call the API — the researcher view's URL. */
  allowedOrigins: string[];
}

export function buildServer(options: ServerOptions) {
  const { db, auth } = options;
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });

  app.addHook("onSend", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "authorization,content-type");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  app.options("/*", async (_request, reply) => reply.status(204).send());

  /** Resolve the caller, or end the request with the reason they cannot pass. */
  async function requirePerson(
    request: FastifyRequest,
    reply: FastifyReply,
    capability: Capability,
  ): Promise<Person | null> {
    const person = await auth.person(request.headers.authorization);
    if (!person) {
      await reply.status(401).send({ error: "sign in required" });
      return null;
    }
    if (person.roles.length === 0) {
      // Authenticated but not authorised: an account exists and has been given
      // no role. Say so plainly rather than showing an empty study.
      await reply.status(403).send({
        error: "your account has no role in this study — ask an owner to give you one",
      });
      return null;
    }
    if (!can(person, capability)) {
      await reply.status(403).send({ error: `your role does not allow: ${capability}` });
      return null;
    }
    return person;
  }

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, at: new Date().toISOString() };
  });

  /** Who am I, and what may I do — so the view can hide what it cannot use. */
  app.get("/me", async (request, reply) => {
    const person = await auth.person(request.headers.authorization);
    if (!person) return reply.status(401).send({ error: "sign in required" });
    return { ...person, capabilities: [...new Set(person.roles.flatMap((r) => [...CAPABILITIES[r]]))] };
  });

  // ── Devices post sittings ──────────────────────────────────────────────
  app.post("/sync/batches", async (request, reply) => {
    const device = await deviceFor(db, request.headers.authorization);
    if (!device) return reply.status(401).send({ error: "device not enrolled, or enrolment revoked" });

    const parsed = batchShape.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "batch rejected", detail: parsed.error.flatten() });
    }
    const ack = await ingestBatch(db, device, parsed.data);
    return reply.status(ack.duplicate ? 200 : 201).send(ack);
  });

  // ── People read the study ──────────────────────────────────────────────
  app.get("/studies/:study/sessions", async (request, reply) => {
    const person = await requirePerson(request, reply, "read");
    if (!person) return;
    const { study } = request.params as { study: string };
    const includeQuarantined = (request.query as { quarantined?: string }).quarantined === "true";
    return { sessions: await storedSessions(db, study, includeQuarantined) };
  });

  app.get("/studies/:study/quarantine", async (request, reply) => {
    const person = await requirePerson(request, reply, "resolve_quarantine");
    if (!person) return;
    const { rows } = await db.query(
      `SELECT q.quarantine_id, q.session_id, q.device_id, q.reason, q.received_at, q.resolved_at, q.resolution
         FROM research.quarantine q
         JOIN research.sessions s ON s.session_id = q.session_id
        WHERE s.study = $1 AND q.resolved_at IS NULL
        ORDER BY q.received_at DESC`,
      [(request.params as { study: string }).study],
    );
    return { quarantine: rows };
  });

  // ── Owners administer ──────────────────────────────────────────────────
  const enrolShape = z.object({ label: z.string().min(1), study: z.string().min(1) });

  app.post("/devices", async (request, reply) => {
    const person = await requirePerson(request, reply, "enrol_devices");
    if (!person) return;
    const parsed = enrolShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "label and study are required" });

    const { token, hash } = mintDeviceToken();
    const deviceId = `dev_${hash.slice(0, 16)}`;
    await db.query(
      `INSERT INTO research.devices (device_id, label, study, token_hash, enrolled_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, parsed.data.label, parsed.data.study, hash, person.subject],
    );
    await audit(db, {
      actor: person.subject,
      action: "device.enrolled",
      study: parsed.data.study,
      subject: deviceId,
      detail: { label: parsed.data.label },
    });
    // The token is shown once. There is no endpoint that can retrieve it again,
    // because the server only ever stored its hash.
    return reply.status(201).send({ deviceId, label: parsed.data.label, token });
  });

  app.get("/devices", async (request, reply) => {
    const person = await requirePerson(request, reply, "enrol_devices");
    if (!person) return;
    const { rows } = await db.query(
      `SELECT device_id, label, study, enrolled_by, enrolled_at, last_seen_at, revoked_at
         FROM research.devices ORDER BY enrolled_at DESC`,
    );
    return { devices: rows };
  });

  app.post("/devices/:deviceId/revoke", async (request, reply) => {
    const person = await requirePerson(request, reply, "enrol_devices");
    if (!person) return;
    const { deviceId } = request.params as { deviceId: string };
    const result = await db.query(
      "UPDATE research.devices SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
      [deviceId],
    );
    await audit(db, { actor: person.subject, action: "device.revoked", subject: deviceId });
    // Revocation is how a lost iPad stops being able to reach the study, so it
    // says plainly whether it changed anything.
    return { deviceId, revoked: result.rowCount > 0 };
  });

  // ── Linkage: names back out, and the join to the UPN ───────────────────
  // Owner-only, justification required, every call logged whether it found
  // anything or not.
  app.post("/identity/lookup", async (request, reply) => {
    const person = await requirePerson(request, reply, "read_identifiers");
    if (!person) return;
    const parsed = lookupShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const found = await lookupByCode(db, person.subject, parsed.data);
    return found ?? reply.status(404).send({ error: "no registry entry for that code" });
  });

  app.post("/identity/search", async (request, reply) => {
    const person = await requirePerson(request, reply, "read_identifiers");
    if (!person) return;
    const parsed = searchShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return { hits: await searchByPerson(db, person.subject, parsed.data) };
  });

  app.post("/identity/upn", async (request, reply) => {
    const person = await requirePerson(request, reply, "read_identifiers");
    if (!person) return;
    const parsed = upnShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await linkUpn(db, person.subject, parsed.data);
    return result.linked ? result : reply.status(409).send(result);
  });

  app.post("/identity/corrections", async (request, reply) => {
    const person = await requirePerson(request, reply, "read_identifiers");
    if (!person) return;
    const parsed = correctionShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await recordCorrection(db, person.subject, parsed.data);
    return result.recorded ? result : reply.status(409).send(result);
  });

  app.get("/studies/:study/corrections", async (request, reply) => {
    const person = await requirePerson(request, reply, "read");
    if (!person) return;
    const { study } = request.params as { study: string };
    const { rows } = await db.query(
      `SELECT correction_id, wrong_code, right_code, reason, made_by, made_at, withdrawn_at
         FROM research.code_corrections WHERE study = $1 ORDER BY made_at DESC`,
      [study],
    );
    // The live map is returned too, because it is what the researcher view
    // must pass to ingest for the corrections to take effect.
    return { corrections: rows, aliases: await aliasesFor(db, study) };
  });

  app.post("/studies/:study/corrections/:id/withdraw", async (request, reply) => {
    const person = await requirePerson(request, reply, "read_identifiers");
    if (!person) return;
    const { study, id } = request.params as { study: string; id: string };
    return { withdrawn: await withdrawCorrection(db, person.subject, study, Number(id)) };
  });

  app.get("/identity/access-log", async (request, reply) => {
    const person = await requirePerson(request, reply, "manage_people");
    if (!person) return;
    const { rows } = await db.query(
      "SELECT access_id, at, actor, action, participant, justification FROM identity.access_log ORDER BY at DESC LIMIT 500",
    );
    return { accessLog: rows };
  });

  app.get("/audit", async (request, reply) => {
    const person = await requirePerson(request, reply, "manage_people");
    if (!person) return;
    const { rows } = await db.query(
      "SELECT audit_id, at, actor, action, study, subject, detail FROM research.audit ORDER BY at DESC LIMIT 500",
    );
    return { audit: rows };
  });

  /** The roles that exist, so an owner can see what they are granting. */
  app.get("/roles", async (request, reply) => {
    const person = await requirePerson(request, reply, "manage_people");
    if (!person) return;
    return { roles: ROLES.map((role) => ({ role, capabilities: CAPABILITIES[role] })) };
  });

  return app;
}

/** Entry point for the container. */
export async function main(): Promise<void> {
  const connectionString = required("DATABASE_URL");
  const db = createPostgres({ connectionString, ssl: process.env["PGSSL"] === "require" });
  const ran = await migrate(db, { includeRoles: process.env["MYSELF_SKIP_ROLE_MIGRATION"] !== "1" });
  if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);

  const app = buildServer({
    db,
    auth: new Authenticator({
      issuer: required("OIDC_ISSUER"),
      audience: process.env["OIDC_AUDIENCE"] ?? "myself",
      devBypass: process.env["MYSELF_DEV_AUTH"] === "1",
    }),
    allowedOrigins: (process.env["ALLOWED_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });

  const port = Number(process.env["PORT"] ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
