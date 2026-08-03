import { beforeEach, describe, expect, it } from "vitest";
import { Authenticator, CAPABILITIES, can, hashToken, mintDeviceToken, rolesFromClaims } from "./auth.js";
import { migrate, type Db } from "./db/index.js";
import { batchId, ingestBatch, storedSessions, type SyncBatch } from "./routes/sync.js";
import { buildServer } from "./server.js";
import { createTestDb } from "./testing/pglite.js";

/**
 * These run against the real Postgres engine, not a mock. The behaviours worth
 * testing here are all about what happens when something goes wrong in the
 * field — a retried upload, two iPads with the same session, a revoked device,
 * an account with no role — and every one of them is decided by SQL.
 */

let db: Db;

const device = { deviceId: "dev_a", label: "iPad 1", study: "ybm" };

async function enrol(id: string, study = "ybm"): Promise<string> {
  const { token, hash } = mintDeviceToken();
  await db.query(
    `INSERT INTO research.devices (device_id, label, study, token_hash, enrolled_by)
     VALUES ($1, $2, $3, $4, 'test')`,
    [id, id, study, hash],
  );
  return token;
}

const batch = (sessionId: string, events = 3, overrides: Partial<SyncBatch["sessions"][number]> = {}): SyncBatch => ({
  sessions: [
    {
      sessionId,
      studyCode: "NDC0042",
      releaseKey: "ybm_nd2026_standard",
      releaseHash: "sha256:abc",
      startedAt: "2026-09-01T09:00:00.000Z",
      complete: true,
      events: Array.from({ length: events }, (_, i) => ({
        seq: i,
        type: i === 0 ? "session.started" : "response.recorded",
        ...(i === 0 ? {} : { itemKey: `inst.q${i}` }),
        payload: { value: { kind: "choice", code: i } },
        tWall: "2026-09-01T09:00:00.000Z",
        tMono: i * 1000,
      })),
      ...overrides,
    },
  ],
});

beforeEach(async () => {
  db = await createTestDb();
  // Role grants are a cluster concern; the embedded engine has one user.
  await migrate(db, { includeRoles: false });
  await db.query(
    `INSERT INTO research.devices (device_id, label, study, token_hash, enrolled_by)
     VALUES ('dev_a', 'iPad 1', 'ybm', 'hash_a', 'test')`,
  );
});

describe("sync", () => {
  it("stores a batch and acknowledges exactly what it accepted", async () => {
    const ack = await ingestBatch(db, device, batch("ses_1"));
    expect(ack.duplicate).toBe(false);
    expect(ack.accepted).toEqual([{ sessionId: "ses_1", events: [0, 1, 2] }]);
    expect(ack.ackHash).toMatch(/^[0-9a-f]{64}$/);
    const events = await db.query("SELECT seq FROM research.events WHERE session_id = 'ses_1'");
    expect(events.rows).toHaveLength(3);
  });

  it("is idempotent: the same batch twice adds nothing", async () => {
    // The failure this prevents is a child's answers counted twice because a
    // school wifi dropped the response to the first upload.
    const first = await ingestBatch(db, device, batch("ses_1"));
    const second = await ingestBatch(db, device, batch("ses_1"));
    expect(second.duplicate).toBe(true);
    expect(second.ackHash).toBe(first.ackHash);
    const events = await db.query("SELECT seq FROM research.events WHERE session_id = 'ses_1'");
    expect(events.rows).toHaveLength(3);
  });

  it("accepts later events for a sitting without re-adding the earlier ones", async () => {
    await ingestBatch(db, device, batch("ses_1", 3));
    const ack = await ingestBatch(db, device, batch("ses_1", 5));
    expect(ack.duplicate).toBe(false);
    // Only the two new events are acknowledged.
    expect(ack.accepted).toEqual([{ sessionId: "ses_1", events: [3, 4] }]);
    const events = await db.query("SELECT seq FROM research.events WHERE session_id = 'ses_1'");
    expect(events.rows).toHaveLength(5);
  });

  it("quarantines a sitting that arrives from a second device instead of merging", async () => {
    // Two devices claiming one session may mean two children. Merging is the
    // one outcome that is unrecoverable, so it never happens automatically.
    await ingestBatch(db, device, batch("ses_1"));
    await enrol("dev_b");
    const ack = await ingestBatch(db, { deviceId: "dev_b", label: "iPad 2", study: "ybm" }, batch("ses_1"));

    expect(ack.quarantined).toEqual([
      { sessionId: "ses_1", reason: "same sitting received from a second device" },
    ]);
    const held = await db.query<{ payload: unknown }>("SELECT payload FROM research.quarantine");
    expect(held.rows).toHaveLength(1);
    // Both copies survive: the stored one and the one that was refused.
    expect(held.rows[0]!.payload).toBeTruthy();
    const flagged = await db.query<{ quarantined: boolean }>(
      "SELECT quarantined FROM research.sessions WHERE session_id = 'ses_1'",
    );
    expect(flagged.rows[0]!.quarantined).toBe(true);
  });

  it("quarantines a sitting whose release hash contradicts the stored copy", async () => {
    await ingestBatch(db, device, batch("ses_1"));
    const ack = await ingestBatch(db, device, batch("ses_1", 3, { releaseHash: "sha256:different" }));
    expect(ack.quarantined[0]?.reason).toMatch(/release hash/);
  });

  it("keeps quarantined sittings out of what a reader is given", async () => {
    await ingestBatch(db, device, batch("ses_1"));
    await ingestBatch(db, device, batch("ses_2"));
    await enrol("dev_b");
    await ingestBatch(db, { deviceId: "dev_b", label: "iPad 2", study: "ybm" }, batch("ses_1"));

    const clean = await storedSessions(db, "ybm");
    expect(clean.map((s) => s.sessionId)).toEqual(["ses_2"]);
    const all = await storedSessions(db, "ybm", true);
    expect(all.map((s) => s.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
  });

  it("hands sittings back in the shape the store ingests", async () => {
    await ingestBatch(db, device, batch("ses_1"));
    const [session] = await storedSessions(db, "ybm");
    expect(session).toMatchObject({
      sessionId: "ses_1",
      studyCode: "NDC0042",
      releaseHash: "sha256:abc",
      complete: true,
    });
    expect(session!.startedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(session!.events[1]).toMatchObject({ seq: 1, type: "response.recorded", itemKey: "inst.q1" });
  });

  it("gives the same batch the same id from the same device, a different one from another", async () => {
    expect(batchId("dev_a", batch("ses_1"))).toBe(batchId("dev_a", batch("ses_1")));
    expect(batchId("dev_a", batch("ses_1"))).not.toBe(batchId("dev_b", batch("ses_1")));
  });

  it("does not treat a different upload as a replay because it has the same shape", async () => {
    // The id covers the whole content. Hashing only session ids and event
    // counts made two genuinely different uploads collide, and the second was
    // dropped in silence — the worst way to lose a sitting.
    const one = batch("ses_1", 3);
    const other = batch("ses_1", 3, { releaseHash: "sha256:different" });
    expect(batchId("dev_a", one)).not.toBe(batchId("dev_a", other));

    const changedAnswer = batch("ses_1", 3);
    changedAnswer.sessions[0]!.events[1]!.payload = { value: { kind: "choice", code: 99 } };
    expect(batchId("dev_a", one)).not.toBe(batchId("dev_a", changedAnswer));
  });

  it("writes an audit row for every batch", async () => {
    await ingestBatch(db, device, batch("ses_1"));
    const { rows } = await db.query<{ action: string; actor: string }>("SELECT action, actor FROM research.audit");
    expect(rows[0]).toMatchObject({ action: "sync.batch", actor: "device:dev_a" });
  });
});

describe("roles", () => {
  it("gives each role only what it should have", () => {
    const analyst = { subject: "a", email: null, name: null, roles: ["analyst" as const] };
    expect(can(analyst, "read")).toBe(true);
    expect(can(analyst, "export")).toBe(false);
    expect(can(analyst, "enrol_devices")).toBe(false);

    const researcher = { subject: "r", email: null, name: null, roles: ["researcher" as const] };
    expect(can(researcher, "export")).toBe(true);
    // Enrolling a device and reading a name are owner-only, deliberately.
    expect(can(researcher, "enrol_devices")).toBe(false);
    expect(can(researcher, "read_identifiers")).toBe(false);

    const owner = { subject: "o", email: null, name: null, roles: ["owner" as const] };
    for (const capability of CAPABILITIES.owner) expect(can(owner, capability)).toBe(true);
  });

  it("reads roles from the provider's claims, with or without the prefix", () => {
    expect(rolesFromClaims({ realm_access: { roles: ["myself-owner", "offline_access"] } })).toEqual(["owner"]);
    expect(rolesFromClaims({ roles: ["analyst"] })).toEqual(["analyst"]);
    expect(rolesFromClaims({})).toEqual([]);
  });

  it("refuses to run without authentication in production", () => {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    expect(() => new Authenticator({ issuer: "https://x", audience: "myself", devBypass: true })).toThrow(
      /cannot be enabled in production/,
    );
    process.env["NODE_ENV"] = previous;
  });
});

describe("device tokens", () => {
  it("stores only a hash, so a database dump cannot sync", async () => {
    const { token, hash } = mintDeviceToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(token.length).toBeGreaterThan(32);
  });
});

describe("the API surface", () => {
  const auth = new Authenticator({ issuer: "https://localhost/none", audience: "myself", devBypass: true });
  const server = () => buildServer({ db, auth, allowedOrigins: ["https://example.org"] });

  it("turns an unknown device away from sync", async () => {
    const app = server();
    const res = await app.inject({
      method: "POST",
      url: "/sync/batches",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: batch("ses_1"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a batch from an enrolled device and refuses it after revocation", async () => {
    const app = server();
    const token = await enrol("dev_c");
    const send = () =>
      app.inject({
        method: "POST",
        url: "/sync/batches",
        headers: { authorization: `Bearer ${token}` },
        payload: batch("ses_9"),
      });

    expect((await send()).statusCode).toBe(201);
    await db.query("UPDATE research.devices SET revoked_at = now() WHERE device_id = 'dev_c'");
    // A lost iPad stops being able to reach the study the moment it is revoked.
    expect((await send()).statusCode).toBe(401);
  });

  it("tells a signed-in person with no role what is wrong", async () => {
    const app = server();
    const res = await app.inject({
      method: "GET",
      url: "/studies/ybm/sessions",
      headers: { authorization: "Bearer dev:nobody:" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/no role/);
  });

  it("lets an analyst read and stops them enrolling a device", async () => {
    const app = server();
    const read = await app.inject({
      method: "GET",
      url: "/studies/ybm/sessions",
      headers: { authorization: "Bearer dev:ana:analyst" },
    });
    expect(read.statusCode).toBe(200);

    const enrolAttempt = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { authorization: "Bearer dev:ana:analyst" },
      payload: { label: "iPad 3", study: "ybm" },
    });
    expect(enrolAttempt.statusCode).toBe(403);
  });

  it("shows an enrolment token once and never again", async () => {
    const app = server();
    const created = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { authorization: "Bearer dev:owner:owner" },
      payload: { label: "iPad 4", study: "ybm" },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token).toBeTruthy();

    const listed = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { authorization: "Bearer dev:owner:owner" },
    });
    expect(JSON.stringify(listed.json())).not.toContain(token);
  });

  it("requires authentication for everything except health", async () => {
    const app = server();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    for (const url of ["/studies/ybm/sessions", "/devices", "/audit", "/roles"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});
