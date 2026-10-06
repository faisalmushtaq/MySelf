import { beforeEach, describe, expect, it, vi } from "vitest";
import { protocols } from "@myself/narrative";
import type { ReleaseManifest } from "@myself/schema";
import type { ModelConfig } from "@myself/llm";

/**
 * A participant's iPad talking to MyStory (D-55, docs/09 §5).
 *
 * The research team decided any participant's iPad may use the model for
 * MyStory, with a daily cap. What has to be true for that to be safe, and what
 * these pin down:
 *
 *   - the iPad's own credential is admitted only where an endpoint asks for it,
 *     and an anonymous sign-in token still buys nothing;
 *   - an iPad runs only what its sitting's release froze;
 *   - two limits — its own and the study's — and only calls let through count;
 *   - "off" is a setting, and a typo in it fails closed;
 *   - a refusal says, in words a participant can read, that the day is over;
 *   - a run, or a recording, belongs to whoever first stored it.
 *
 * The decisions are tested here against a stand-in. Whether the counts hold when a
 * hall of iPads calls at the same instant is the integration suite's question
 * (`integration/participant-devices.integration.test.ts`), because only a real
 * database has real contention.
 */

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));

/** Enough Firestore for a transaction that reads two documents and writes some. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const snap = (path: string) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const write = (path: string, value: Record<string, unknown>, options?: { merge?: boolean }) =>
    docs.set(path, options?.merge ? { ...(docs.get(path) ?? {}), ...value } : value);
  const db = {
    doc: (path: string) => ({ path, get: async () => snap(path) }),
    getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path)),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      // Writes land at commit, as they do in Firestore, so a body cannot read
      // back its own uncommitted write.
      const queued: (() => void)[] = [];
      const tx = {
        get: async (r: { path: string }) => snap(r.path),
        getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path)),
        set: (r: { path: string }, value: Record<string, unknown>, options?: { merge?: boolean }) => {
          queued.push(() => write(r.path, value, options));
          return tx;
        },
        update: (r: { path: string }, value: Record<string, unknown>) => {
          queued.push(() => write(r.path, value, { merge: true }));
          return tx;
        },
      };
      const result = await body(tx);
      queued.forEach((f) => f());
      return result;
    },
    collection: () => ({ add: async () => undefined }),
  };
  return { docs, db: db as unknown as FirebaseFirestore.Firestore };
}

let fake = fakeDb();
const verifyIdToken = vi.fn();

vi.mock("./apps.js", () => ({
  STUDY: "ybm",
  REGION: "europe-west2",
  research: () => fake.db,
  auth: () => ({ verifyIdToken }),
  identity: () => {
    throw new Error("not in this suite");
  },
}));

const { authenticate, meter, meterDevice, refuse } = await import("./relay.js");
const {
  DEVICE_LIMITS,
  RelayError,
  configFor,
  configForCall,
  deviceLimitError,
  deviceLimitMessage,
  deviceLimitReached,
  isParticipantDevice,
  readLimit,
  secondsUntilTomorrow,
} = await import("./relay-policy.js");
const { narrativeRefusal, sessionClaimRefusal, storeNarrative } = await import("./narratives.js");
type Caller = import("./relay-policy.js").Caller;

beforeEach(() => {
  fake = fakeDb();
  verifyIdToken.mockReset();
});

const ipad: Caller = { uid: "ipad_01ABC", device: true, anonymous: true };
const otherIpad: Caller = { uid: "ipad_02DEF", device: true, anonymous: true };
const enrolled: Caller = { uid: "dev_enrolled", device: true, anonymous: false };
const researcher: Caller = { uid: "res_1", device: false, anonymous: false };
const tester: Caller = { uid: "link_abc123", device: false, anonymous: false };

/** What an iPad generates for itself on first launch. */
const credential = (installId = "ipad_01ABC", secret = "s".repeat(43)) => `Device ${installId}.${secret}`;

const refused = async (promise: Promise<unknown>): Promise<InstanceType<typeof RelayError>> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RelayError) return error;
    throw error;
  }
  throw new Error("that was accepted, and it should not have been");
};

describe("who is a participant's iPad", () => {
  it("is a device on its own credential, and nobody else", () => {
    expect(isParticipantDevice(ipad)).toBe(true);
    // An iPad an owner enrolled keeps its old rules and its old ceiling.
    expect(isParticipantDevice(enrolled)).toBe(false);
    expect(isParticipantDevice(researcher)).toBe(false);
    expect(isParticipantDevice(tester)).toBe(false);
  });
});

describe("the device credential, at the door", () => {
  it("is refused by an endpoint that did not ask for it, before anything is written", async () => {
    const error = await refused(authenticate(credential()));
    expect(error).toMatchObject({ status: 403, kind: "auth" });
    expect(error.message).toMatch(/cannot be used for this/);
    expect(fake.docs.size).toBe(0);
  });

  it("is admitted where the endpoint asks for it, as a participant's iPad registered first-writer-wins", async () => {
    const caller = await authenticate(credential(), { allowDeviceCredential: true });
    expect(caller).toEqual({ uid: "ipad_01ABC", device: true, anonymous: true });
    expect(isParticipantDevice(caller)).toBe(true);
    // The same registration `saveSitting` makes, so one iPad is one identity.
    expect(fake.docs.get("studies/ybm/devices/ipad_01ABC")).toMatchObject({ deviceId: "ipad_01ABC", selfRegistered: true });
    expect(JSON.stringify([...fake.docs.values()])).not.toContain("s".repeat(43));
  });

  it("still refuses a second iPad claiming an installation another already holds", async () => {
    await authenticate(credential(), { allowDeviceCredential: true });
    const error = await refused(authenticate(credential("ipad_01ABC", "t".repeat(43)), { allowDeviceCredential: true }));
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/another device is already registered/);
  });

  it("refuses a device an owner stopped, so stopping a device stops its MyStory calls", async () => {
    fake.docs.set("studies/ybm/devices/ipad_01ABC", { secretHash: "x", revokedAt: new Date() });
    const error = await refused(authenticate(credential(), { allowDeviceCredential: true }));
    expect(error.message).toMatch(/withdrawn from the study/);
  });

  it("does not let an anonymous sign-in token through on the strength of it", async () => {
    // The older route an iPad used to file sittings. Nobody decided to let it spend.
    verifyIdToken.mockResolvedValue({ uid: "anon_1", firebase: { sign_in_provider: "anonymous" } });
    const error = await refused(authenticate("Bearer some-token", { allowDeviceCredential: true }));
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/no role/);
  });

  it("leaves a researcher's token and filing sittings exactly as they were", async () => {
    verifyIdToken.mockResolvedValue({ uid: "res_1", role: "researcher" });
    await expect(authenticate("Bearer t", { allowDeviceCredential: true })).resolves.toEqual(researcher);
    await expect(authenticate(credential(), { allowAnonymous: true })).resolves.toMatchObject({ uid: "ipad_01ABC" });
  });
});

describe("what a participant's iPad may run", () => {
  const shipped = protocols[0]!.models.find((m) => m.provider !== "mock")!;
  const frozen: ModelConfig = { ...(shipped as ModelConfig), maxOutputTokens: 321 };
  const HASH = `sha256:${"d".repeat(64)}`;
  const release = { hash: HASH, modelConfigs: { [shipped.key]: frozen } } as unknown as ReleaseManifest;
  const store = async (hash: string) => (hash === HASH ? release : null);

  it("must name its release, and is refused without one", async () => {
    // Its credential only reaches the module through the survey, which always
    // knows the release; without one it could pick a shipped protocol's config.
    const error = await refused(configForCall(shipped.key, ipad, undefined, store));
    expect(error).toMatchObject({ status: 400 });
    expect(error.message).toMatch(/did not say which version/);
  });

  it("runs exactly what that release froze, and nothing a release did not", async () => {
    expect((await configForCall(shipped.key, ipad, HASH, store)).maxOutputTokens).toBe(321);
    await expect(configForCall("mc.something.else", ipad, HASH, store)).rejects.toMatchObject({ status: 400 });
    await expect(configForCall(shipped.key, ipad, `sha256:${"e".repeat(64)}`, store)).rejects.toThrow(/has not published/);
  });

  it("leaves everybody else's call with no release decided as before", async () => {
    await expect(configForCall(shipped.key, researcher, undefined, store)).resolves.toEqual(configFor(shipped.key, researcher));
    await expect(configForCall(shipped.key, tester, undefined, store)).resolves.toEqual(configFor(shipped.key, tester));
    // An enrolled iPad is still held to released configs, and still refused a draft one.
    await expect(configForCall("mc.made.up", enrolled, undefined, store)).rejects.toThrow();
  });
});

describe("reading a limit from a setting", () => {
  it("takes the default when the setting is absent or blank", () => {
    // An unset repository variable reaches the function as an empty string.
    expect(readLimit(undefined, 120)).toBe(120);
    expect(readLimit("", 120)).toBe(120);
    expect(readLimit("   ", 120)).toBe(120);
  });

  it("takes a whole number, including zero, which is the off switch", () => {
    expect(readLimit("300", 120)).toBe(300);
    expect(readLimit(" 300 ", 120)).toBe(300);
    expect(readLimit("0", 120)).toBe(0);
  });

  it("fails closed on anything else, so a typo switches devices off rather than removing the limit", () => {
    for (const typo of ["2,000", "-1", "lots", "1.5", "Infinity", "NaN", "1e400"]) {
      expect(readLimit(typo, 120), typo).toBe(0);
    }
  });

  it("ships finite, positive defaults sized for a few conversations a day", () => {
    expect(DEVICE_LIMITS).toEqual({ perDevice: 120, allDevices: 2_000 });
  });
});

describe("whether one more call fits", () => {
  const limits = { perDevice: 3, allDevices: 10 };

  it("lets a call through under both limits", () => {
    expect(deviceLimitReached(limits, 0, 0)).toBeNull();
    expect(deviceLimitReached(limits, 2, 9)).toBeNull();
  });

  it("refuses at a limit, not one past it", () => {
    // The call being checked is the one that would exceed it.
    expect(deviceLimitReached(limits, 3, 0)).toBe("device");
    expect(deviceLimitReached(limits, 0, 10)).toBe("study");
  });

  it("names the device's own day before the study's", () => {
    // So a device past its own limit is never counted against everybody else's.
    expect(deviceLimitReached(limits, 3, 10)).toBe("device");
  });

  it("calls either limit at zero switched off, not reached", () => {
    expect(deviceLimitReached({ perDevice: 0, allDevices: 10 }, 0, 0)).toBe("off");
    expect(deviceLimitReached({ perDevice: 3, allDevices: 0 }, 0, 0)).toBe("off");
  });
});

describe("counting a participant's iPad's calls", () => {
  const day = (at: Date) => at.toISOString().slice(0, 10);
  const now = new Date("2026-10-06T10:00:00Z");
  const mine = (uid = "ipad_01ABC") => `studies/ybm/audit_relayDevices/${day(now)}_${uid}`;
  const study = `studies/ybm/audit_relayDevices/${day(now)}`;

  it("counts each call against the device and the study together", async () => {
    await meterDevice(fake.db, "ybm", ipad, { perDevice: 3, allDevices: 10 }, now);
    await meterDevice(fake.db, "ybm", otherIpad, { perDevice: 3, allDevices: 10 }, now);
    expect(fake.docs.get(mine())).toMatchObject({ calls: 1, uid: "ipad_01ABC" });
    expect(fake.docs.get(mine("ipad_02DEF"))).toMatchObject({ calls: 1 });
    expect(fake.docs.get(study)).toMatchObject({ calls: 2 });
  });

  it("refuses the call past the device's limit, and does not count it against the study", async () => {
    const limits = { perDevice: 2, allDevices: 10 };
    await meterDevice(fake.db, "ybm", ipad, limits, now);
    await meterDevice(fake.db, "ybm", ipad, limits, now);
    const error = await refused(meterDevice(fake.db, "ybm", ipad, limits, now));
    expect(error).toMatchObject({ status: 429, kind: "rate_limit", retryable: false, limit: "device" });
    expect(fake.docs.get(mine())).toMatchObject({ calls: 2 });
    expect(fake.docs.get(mine())).toHaveProperty("refused");
    expect(fake.docs.get(study)).toMatchObject({ calls: 2 });
    // Another iPad's day is its own.
    await expect(meterDevice(fake.db, "ybm", otherIpad, limits, now)).resolves.toBeUndefined();
  });

  it("refuses every device once the study's ceiling is reached, however new the device", async () => {
    // The one a per-device limit cannot provide: a stranger's hundredth new installation.
    const limits = { perDevice: 5, allDevices: 2 };
    await meterDevice(fake.db, "ybm", ipad, limits, now);
    await meterDevice(fake.db, "ybm", otherIpad, limits, now);
    const brandNew: Caller = { uid: "ipad_NEW", device: true, anonymous: true };
    const error = await refused(meterDevice(fake.db, "ybm", brandNew, limits, now));
    expect(error.limit).toBe("study");
    expect(fake.docs.get(study)).toMatchObject({ calls: 2 });
    expect(fake.docs.has(mine("ipad_NEW"))).toBe(false);
  });

  it("starts again the next UTC day", async () => {
    const limits = { perDevice: 1, allDevices: 10 };
    await meterDevice(fake.db, "ybm", ipad, limits, now);
    await expect(meterDevice(fake.db, "ybm", ipad, limits, now)).rejects.toMatchObject({ limit: "device" });
    await expect(meterDevice(fake.db, "ybm", ipad, limits, new Date("2026-10-07T00:00:01Z"))).resolves.toBeUndefined();
  });

  it("touches nothing when switched off", async () => {
    const error = await refused(meterDevice(fake.db, "ybm", ipad, { perDevice: 0, allDevices: 2_000 }, now));
    expect(error).toMatchObject({ status: 429, limit: "off" });
    expect(fake.docs.size).toBe(0);
  });

  it("is what `meter` does for a participant's iPad, in a collection of its own", async () => {
    // Not the per-caller counter: an installation id is a name the caller chose,
    // and must not be able to share a counter with somebody's account.
    await meter(ipad);
    const paths = [...fake.docs.keys()];
    expect(paths.some((p) => p.startsWith("studies/ybm/audit_relayDevices/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("studies/ybm/audit_relay/"))).toBe(false);
  });

  it("leaves a researcher on the per-caller counter", async () => {
    await meter(researcher);
    const paths = [...fake.docs.keys()];
    expect(paths.some((p) => p.startsWith("studies/ybm/audit_relay/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("studies/ybm/audit_relayDevices/"))).toBe(false);
  });
});

describe("what a participant reads when a limit refuses the call", () => {
  // The same test the tester link's refusals pass: this reaches a child's
  // conversation, not a terminal.
  const JARGON = /\b(relay|credential|caller|endpoint|payload|token|uid|schema|parse|null|undefined|400|429|502|quota|limit)\b/i;

  it("says nothing about the plumbing, and starts like a sentence", () => {
    for (const limit of ["device", "study", "off"] as const) {
      const message = deviceLimitMessage(limit);
      expect(message, `jargon in: ${message}`).not.toMatch(JARGON);
      expect(message[0]).toBe(message[0]!.toUpperCase());
    }
  });

  it("always says the survey can go on, and that nothing is lost", () => {
    for (const limit of ["device", "study", "off"] as const) {
      expect(deviceLimitMessage(limit)).toMatch(/carry on without it/);
      expect(deviceLimitMessage(limit)).toMatch(/nothing you have already answered is lost/);
    }
  });

  it("says tomorrow for a day that is over, and never for a switch that is off", () => {
    expect(deviceLimitMessage("device")).toMatch(/This device .* tomorrow/);
    expect(deviceLimitMessage("study")).toMatch(/tomorrow/);
    expect(deviceLimitMessage("off")).toMatch(/switched off/);
    expect(deviceLimitMessage("off")).not.toMatch(/tomorrow/);
  });

  it("is sent as a refusal the gateway will not retry at once", () => {
    // A retry a second later meets the same count.
    expect(deviceLimitError("study")).toMatchObject({ status: 429, kind: "rate_limit", retryable: false, limit: "study" });
  });
});

describe("how a refusal is sent", () => {
  function response() {
    const headers: Record<string, string> = {};
    let status = 0;
    let body: unknown = null;
    const res = {
      set: (key: string, value: string) => void (headers[key] = value),
      status: (code: number) => {
        status = code;
        return { json: (b: unknown) => void (body = b) };
      },
    };
    return { res, sent: () => ({ headers, status, body }) };
  }

  it("carries the limit and when to ask again, so the module can say the day is over", () => {
    const { res, sent } = response();
    refuse(res, deviceLimitError("device"), new Date("2026-10-06T23:00:00Z"));
    expect(sent()).toEqual({
      headers: { "Retry-After": "3600" },
      status: 429,
      body: { error: { kind: "rate_limit", message: deviceLimitMessage("device"), retryable: false, limit: "device" } },
    });
  });

  it("names no time to ask again when devices are switched off", () => {
    const { res, sent } = response();
    refuse(res, deviceLimitError("off"));
    expect(sent().headers).toEqual({});
    expect(sent().body).toMatchObject({ error: { limit: "off" } });
  });

  it("sends every other refusal as before, with no limit on it", () => {
    const { res, sent } = response();
    refuse(res, new RelayError(403, "auth", "that credential is not valid"));
    expect(sent()).toEqual({
      headers: {},
      status: 403,
      body: { error: { kind: "auth", message: "that credential is not valid", retryable: false } },
    });
  });

  it("counts down to the next UTC midnight, and never to zero", () => {
    expect(secondsUntilTomorrow(new Date("2026-10-06T00:00:00Z"))).toBe(86_400);
    expect(secondsUntilTomorrow(new Date("2026-10-06T12:00:00Z"))).toBe(43_200);
    expect(secondsUntilTomorrow(new Date("2026-10-06T23:59:59.900Z"))).toBe(1);
  });
});

describe("whose conversation it is", () => {
  const run = {
    sessionId: "ses_01J",
    protocolKey: "np.phone_wellbeing",
    protocolVersion: "0.1.0",
    records: [],
    finished: false,
    releaseHash: `sha256:${"a".repeat(64)}`,
  };

  it("lets the caller who first stored a run keep storing it", () => {
    expect(sessionClaimRefusal(ipad, undefined, undefined)).toBeNull();
    expect(sessionClaimRefusal(ipad, "ipad_01ABC", "ipad_01ABC")).toBeNull();
  });

  it("refuses anybody else, a researcher included", () => {
    expect(sessionClaimRefusal(otherIpad, "ipad_01ABC", undefined)).toMatch(/already stored from another device/);
    expect(sessionClaimRefusal(researcher, "ipad_01ABC", undefined)).toMatch(/another device or account/);
  });

  it("refuses a device attaching a run to a sitting another device filed", () => {
    expect(sessionClaimRefusal(ipad, undefined, "ipad_02DEF")).toMatch(/sitting another device filed/);
    // A person is not a device, and is not held to a sitting's device.
    expect(sessionClaimRefusal(researcher, undefined, "ipad_02DEF")).toBeNull();
  });

  it("asks a participant's iPad which release the run belongs to", () => {
    const { releaseHash: _hash, ...noRelease } = run;
    expect(narrativeRefusal(ipad, noRelease)).toMatch(/which version of the survey/);
    expect(narrativeRefusal(ipad, run)).toBeNull();
    // The lab on its own has no release, and a researcher or a link may still use it.
    expect(narrativeRefusal(researcher, noRelease)).toBeNull();
    expect(narrativeRefusal(tester, noRelease)).toBeNull();
  });

  it("stores a device's run as study data, under that device, and keeps it its own", async () => {
    await storeNarrative(fake.db, "ybm", ipad, run);
    expect(fake.docs.get("studies/ybm/narratives/ses_01J")).toMatchObject({
      uid: "ipad_01ABC",
      provenance: "study",
      releaseHash: run.releaseHash,
    });
    // Its own next turn is fine; another device's write is refused and changes nothing.
    await storeNarrative(fake.db, "ybm", ipad, { ...run, finished: true });
    const error = await refused(storeNarrative(fake.db, "ybm", otherIpad, { ...run, records: [] }));
    expect(error).toMatchObject({ status: 409 });
    expect(fake.docs.get("studies/ybm/narratives/ses_01J")).toMatchObject({ uid: "ipad_01ABC", finished: true });
  });

  it("refuses a device's run for a sitting another device filed, writing nothing", async () => {
    fake.docs.set("studies/ybm/sessions/ses_01J", { deviceId: "ipad_02DEF" });
    await expect(storeNarrative(fake.db, "ybm", ipad, run)).rejects.toMatchObject({ status: 409 });
    expect(fake.docs.has("studies/ybm/narratives/ses_01J")).toBe(false);
  });
});
