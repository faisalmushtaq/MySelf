import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_VERSIONS } from "@myself/release/gate";
import { contentHashAsync } from "@myself/schema";
import type { CachedReleaseRow, ReleaseStateRow, SessionRow } from "./lib/db.js";
import { pickResumable, releasesToPrune } from "./lib/db.js";
import {
  BUILT_IN,
  describeCheck,
  fetchPointer,
  fetchReleaseDocument,
  parsePointerDocument,
  parseReleaseDocument,
  releaseService,
  SUPPORTED_ENGINE_VERSIONS,
  verifyRelease,
  type LoadedRelease,
  type ReleaseCache,
} from "./lib/releases.js";
import { sittingToResume, type ResumeLookup } from "./lib/resume.js";
import { buildRuntime } from "./lib/runtime.js";

/**
 * Loading the published survey onto a device (docs/16 §5.3).
 *
 * Every test here is one way a release could reach a child's screen that it
 * should not — altered, mislabelled, needing a renderer this build lacks, or
 * arriving through a network that is not the study's — or one way the device
 * could stop showing the survey it has because the network misbehaved. The rule
 * in every case is the same: prove it or keep what is running.
 */

const BUILT_IN_TEXT = readFileSync(
  fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json", import.meta.url)),
  "utf8",
);
const BUILT_IN_HASH = (JSON.parse(BUILT_IN_TEXT) as { hash: string }).hash;
const SOURCE = "https://firestore.example.test/v1/projects/p/databases/(default)/documents/studies/ybm";
const SURVEY = "ybm_nd2026_standard";

// Deliberately loose: these tests edit a manifest the way a careless or hostile writer could.
type Json = Record<string, any>;

/**
 * The built-in release changed by `edit`, re-hashed so that it is a genuine release in its own
 * right — the shape a Studio publish produces.
 */
async function derived(edit: (body: Json) => void): Promise<{ json: string; hash: string }> {
  const { hash: _old, ...body } = JSON.parse(BUILT_IN_TEXT) as Json;
  edit(body);
  const hash = await contentHashAsync(body);
  return { json: JSON.stringify({ ...body, hash }), hash };
}

/** A new version: different words on the first screen, and a new version number. */
const nextRelease = () =>
  derived((body) => {
    body["release"]["version"] = "7.2.0";
    body["release"]["key"] = "ybm_nd2026_standard_r7_2_0";
    body["composition"]["studyLabel"] = "Published from the Studio";
  });

function pointerDoc(hash: string, extra: Json = {}): Json {
  return {
    name: `projects/p/databases/(default)/documents/studies/ybm/published/${SURVEY}`,
    fields: {
      surveyId: { stringValue: SURVEY },
      hash: { stringValue: hash },
      version: { stringValue: "7.2.0" },
      releaseKey: { stringValue: "ybm_nd2026_standard_r7_2_0" },
      engineVersion: { stringValue: "0.1.0" },
      generation: { integerValue: "3" },
      publishedAt: { timestampValue: "2026-09-28T12:00:00.000Z" },
      ...extra,
    },
    createTime: "2026-09-28T12:00:00.000Z",
    updateTime: "2026-09-28T12:00:00.000Z",
  };
}

function releaseDoc(hash: string, json: string): Json {
  return {
    name: `projects/p/databases/(default)/documents/studies/ybm/publicReleases/${hash.slice(7)}`,
    fields: { hash: { stringValue: hash }, manifest: { stringValue: json }, bytes: { integerValue: String(json.length) } },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json({ error: { code: 404, message: "Document not found.", status: "NOT_FOUND" } }, 404);

/** A stand-in for Firestore's REST API: the pointer, and whatever releases it holds. */
function study(options: { pointer?: Json | null; releases?: Record<string, Json> }) {
  const calls: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === `${SOURCE}/published/${SURVEY}`) return options.pointer ? json(options.pointer) : notFound();
    const hex = url.startsWith(`${SOURCE}/publicReleases/`) ? url.slice(`${SOURCE}/publicReleases/`.length) : null;
    const doc = hex ? options.releases?.[hex] : undefined;
    return doc ? json(doc) : notFound();
  });
  return { transport: transport as unknown as typeof fetch, calls };
}

/** The Dexie cache's contract, in memory. */
function memoryCache(): ReleaseCache & { rows: Map<string, CachedReleaseRow>; current: ReleaseStateRow | undefined } {
  const rows = new Map<string, CachedReleaseRow>();
  const cache = {
    rows,
    current: undefined as ReleaseStateRow | undefined,
    get: async (hash: string) => rows.get(hash),
    put: async (row: CachedReleaseRow) => void rows.set(row.hash, row),
    state: async () => cache.current,
    saveState: async (patch: Partial<Omit<ReleaseStateRow, "id">>) => {
      cache.current = {
        id: "active",
        activeHash: cache.current?.activeHash ?? null,
        checkedAt: cache.current?.checkedAt ?? null,
        lastResult: cache.current?.lastResult ?? null,
        ...patch,
      };
    },
  };
  return cache;
}

const service = (cache: ReleaseCache, transport?: typeof fetch, extra: { online?: boolean; source?: string } = {}) =>
  releaseService({
    builtIn: BUILT_IN,
    cache,
    source: extra.source ?? SOURCE,
    surveyId: SURVEY,
    ...(transport ? { transport } : {}),
    online: () => extra.online ?? true,
    now: () => new Date("2026-09-28T13:00:00.000Z"),
  });

describe("what this build can render", () => {
  it("declares exactly the engine versions the publish gate can stamp", () => {
    // If the gate learns a new capability, this build must be taught to render it
    // (or to refuse it) in the same change — never find out on a child's screen.
    expect([...SUPPORTED_ENGINE_VERSIONS]).toEqual([...ENGINE_VERSIONS]);
  });

  it("carries r7.3.0 as the built-in release, parsed as App always parsed it", () => {
    expect(BUILT_IN.hash).toBe(BUILT_IN_HASH);
    expect(BUILT_IN.manifest.release.version).toBe("7.3.0");
    expect(BUILT_IN.source).toBe("built-in");
    // And its runtime is today's: the same unit list the flattening tests describe.
    const runtime = buildRuntime(BUILT_IN.manifest);
    expect(runtime.hash).toBe(BUILT_IN_HASH);
    expect(runtime.releaseKey).toBe("ybm_nd2026_standard_r7_3_0");
    expect(runtime.flattened.units.length).toBeGreaterThan(100);
    expect(runtime.unitKeyOf(0)).toBe("ybm_intro_consent.intro");
    expect(runtime.wordsAt(0)).toBeGreaterThan(0);
    expect(runtime.codeRule?.pattern).toBe("^[A-Za-z]{3}[0-9]{4}$");
  });
});

describe("the study's public documents over REST", () => {
  it("reads the pointer, including a generation written as a string", () => {
    expect(parsePointerDocument(pointerDoc(BUILT_IN_HASH))).toEqual({
      hash: BUILT_IN_HASH,
      version: "7.2.0",
      releaseKey: "ybm_nd2026_standard_r7_2_0",
      engineVersion: "0.1.0",
      generation: 3,
      publishedAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("refuses a pointer whose hash is not a content hash", () => {
    expect(parsePointerDocument(pointerDoc("sha256:not-hex"))).toBeNull();
    expect(parsePointerDocument({ fields: {} })).toBeNull();
    expect(parsePointerDocument("<html>")).toBeNull();
  });

  it("reads a release document as the exact string stored", () => {
    expect(parseReleaseDocument(releaseDoc(BUILT_IN_HASH, BUILT_IN_TEXT))).toEqual({ manifest: BUILT_IN_TEXT, hash: BUILT_IN_HASH });
    expect(parseReleaseDocument({ fields: { manifest: { mapValue: {} } } })).toBeNull();
  });

  it("takes a 404 to mean nothing has been published", async () => {
    const { transport, calls } = study({ pointer: null });
    expect(await fetchPointer(SOURCE, SURVEY, { transport })).toEqual({ kind: "none" });
    expect(calls).toEqual([`${SOURCE}/published/${SURVEY}`]);
  });

  it("does not mistake a captive portal's login page for the study", async () => {
    // A school's guest network answers 200 with HTML.
    const transport = (async () =>
      new Response("<!doctype html><title>Sign in to SchoolNet</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const reply = await fetchPointer(SOURCE, SURVEY, { transport });
    expect(reply.kind).toBe("unreachable");
    expect(reply.kind === "unreachable" && reply.reason).toMatch(/did not come from the study/);
    expect((await fetchReleaseDocument(SOURCE, BUILT_IN_HASH, { transport })).kind).toBe("unreachable");
  });

  it("does not mistake somebody else's JSON, or broken JSON, for the study", async () => {
    const other = (async () => json({ status: "ok", portal: true })) as unknown as typeof fetch;
    expect((await fetchPointer(SOURCE, SURVEY, { transport: other })).kind).toBe("unreachable");
    const broken = (async () => new Response('{"fields": {', { status: 200 })) as unknown as typeof fetch;
    expect((await fetchPointer(SOURCE, SURVEY, { transport: broken })).kind).toBe("unreachable");
  });

  it("reports a refusal or a dropped connection as unreachable, never as nothing published", async () => {
    const denied = (async () => json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403)) as unknown as typeof fetch;
    expect(await fetchPointer(SOURCE, SURVEY, { transport: denied })).toEqual({
      kind: "unreachable",
      reason: "the study replied 403",
    });
    const dropped = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchPointer(SOURCE, SURVEY, { transport: dropped })).toEqual({
      kind: "unreachable",
      reason: "Failed to fetch",
    });
  });

  it("gives up on a request that hangs", async () => {
    const hangs = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    expect(await fetchPointer(SOURCE, SURVEY, { transport: hangs, timeoutMs: 20 })).toEqual({
      kind: "unreachable",
      reason: "the request timed out",
    });
  });

  it("asks for the release by the hex of its hash", async () => {
    const { transport, calls } = study({ releases: { [BUILT_IN_HASH.slice(7)]: releaseDoc(BUILT_IN_HASH, BUILT_IN_TEXT) } });
    const reply = await fetchReleaseDocument(SOURCE, BUILT_IN_HASH, { transport });
    expect(reply).toEqual({ kind: "release", json: BUILT_IN_TEXT, storedHash: BUILT_IN_HASH });
    expect(calls).toEqual([`${SOURCE}/publicReleases/${BUILT_IN_HASH.slice(7)}`]);
  });
});

describe("whether a downloaded release may be rendered", () => {
  it("accepts the built-in release exactly as published", async () => {
    const result = await verifyRelease(BUILT_IN_TEXT, BUILT_IN_HASH, { surveyId: SURVEY });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.release.version).toBe("7.3.0");
      expect(result.raw["hash"]).toBe(BUILT_IN_HASH);
    }
  });

  it("accepts a genuinely new release", async () => {
    const next = await nextRelease();
    const result = await verifyRelease(next.json, next.hash, { surveyId: SURVEY });
    expect(result.ok).toBe(true);
  });

  it("refuses a manifest with one label changed and the old hash kept", async () => {
    const tampered = JSON.parse(BUILT_IN_TEXT) as Json;
    tampered["scales"]["scale.yes_no"]["options"][0]["label"] = "Definitely";
    const result = await verifyRelease(JSON.stringify(tampered), BUILT_IN_HASH);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/changed after it was published/) });
  });

  it("refuses a genuine release that is not the one the pointer named", async () => {
    const result = await verifyRelease(BUILT_IN_TEXT, `sha256:${"0".repeat(64)}`);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/not the sha256:0000/) });
  });

  it("refuses a release that needs a renderer this build does not have", async () => {
    const future = await derived((body) => {
      body["release"]["engineVersion"] = "9.0.0";
    });
    const result = await verifyRelease(future.json, future.hash);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/needs survey engine 9\.0\.0/) });
  });

  it("refuses a correctly hashed release with a question that fails the schema", async () => {
    const broken = await derived((body) => {
      body["instruments"]["kss@1.0/en-GB/self/standard"]["forms"][0]["items"][0]["responseType"] = "hologram";
    });
    const result = await verifyRelease(broken.json, broken.hash);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/'kss@1\.0\/en-GB\/self\/standard' is not a valid instrument/) });
  });

  it("refuses a correctly hashed release whose scale or scoring is malformed", async () => {
    const scale = await derived((body) => {
      body["scales"]["scale.yes_no"]["options"] = [];
    });
    expect(await verifyRelease(scale.json, scale.hash)).toEqual({ ok: false, reason: expect.stringMatching(/scale 'scale\.yes_no'/) });
    const scoring = await derived((body) => {
      const key = Object.keys(body["scoring"])[0]!;
      body["scoring"][key]["steps"] = [{ op: "teleport" }];
    });
    expect(await verifyRelease(scoring.json, scoring.hash)).toEqual({ ok: false, reason: expect.stringMatching(/scoring '/) });
  });

  it("refuses a release whose questions cannot be laid out", async () => {
    // A placement of an instrument the release does not carry.
    const orphan = await derived((body) => {
      delete body["instruments"]["kss@1.0/en-GB/self/standard"];
    });
    expect(await verifyRelease(orphan.json, orphan.hash)).toEqual({
      ok: false,
      reason: expect.stringMatching(/cannot be laid out/),
    });
  });

  it("refuses a format rule that would throw the moment a child typed", async () => {
    const bad = await derived((body) => {
      body["composition"]["participantCode"]["pattern"] = "([A-Z";
    });
    expect(await verifyRelease(bad.json, bad.hash)).toEqual({
      ok: false,
      reason: expect.stringMatching(/participant code is not a valid pattern/),
    });
  });

  it("refuses another survey's release", async () => {
    expect(await verifyRelease(BUILT_IN_TEXT, BUILT_IN_HASH, { surveyId: "some_other_survey" })).toEqual({
      ok: false,
      reason: expect.stringMatching(/not 'some_other_survey'/),
    });
  });

  it("refuses what is not JSON, without throwing", async () => {
    expect(await verifyRelease("<html>", BUILT_IN_HASH)).toEqual({ ok: false, reason: "it is not valid JSON" });
    expect(await verifyRelease("[1,2]", BUILT_IN_HASH)).toEqual({ ok: false, reason: "it is not a release manifest" });
  });

  it("does not change the manifest it checks", async () => {
    const raw = JSON.parse(BUILT_IN_TEXT) as Json;
    const before = JSON.stringify(raw);
    const result = await verifyRelease(BUILT_IN_TEXT, BUILT_IN_HASH);
    expect(result.ok && JSON.stringify(result.raw)).toBe(before);
  });
});

describe("what the start screen shows, from this device alone", () => {
  it("is the built-in release when nothing has ever been downloaded", async () => {
    const releases = service(memoryCache());
    expect(await releases.resolveStartupRelease()).toBe(BUILT_IN);
  });

  it("is the cached active release when there is one, verified again as it is read", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    await service(cache).cacheRelease(next.json, next.hash);
    await cache.saveState({ activeHash: next.hash });

    const loaded = await service(cache).resolveStartupRelease();
    expect(loaded.hash).toBe(next.hash);
    expect(loaded.source).toBe("cached");
    expect(loaded.manifest.composition.studyLabel).toBe("Published from the Studio");
  });

  it("falls back to the built-in release when the cached one no longer verifies", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    cache.rows.set(next.hash, {
      hash: next.hash,
      releaseKey: "k",
      version: "7.2.0",
      json: next.json.replace("Published from the Studio", "Altered on the device"),
      cachedAt: "2026-09-28T12:00:00.000Z",
    });
    await cache.saveState({ activeHash: next.hash });
    expect(await service(cache).resolveStartupRelease()).toBe(BUILT_IN);
  });

  it("falls back to the built-in release when storage itself fails", async () => {
    const cache = memoryCache();
    cache.state = async () => {
      throw new Error("IndexedDB is not available");
    };
    expect(await service(cache).resolveStartupRelease()).toBe(BUILT_IN);
  });

  it("finds a sitting's release by hash: built-in, then cache, then nothing", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    const releases = service(cache);
    await releases.cacheRelease(next.json, next.hash);
    expect(await releases.releaseForHash(BUILT_IN_HASH)).toBe(BUILT_IN);
    expect((await releases.releaseForHash(next.hash))?.manifest.release.version).toBe("7.2.0");
    expect(await releases.releaseForHash(`sha256:${"a".repeat(64)}`)).toBeNull();
  });
});

describe("looking for a newer release", () => {
  it("does not ask at all when the build has no study", async () => {
    const { transport, calls } = study({});
    const result = await service(memoryCache(), transport, { source: "" }).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "not_configured" });
    expect(result.activeHash).toBe(BUILT_IN_HASH);
    expect(calls).toEqual([]);
  });

  it("does not ask while offline", async () => {
    const { transport, calls } = study({});
    const result = await service(memoryCache(), transport, { online: false }).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "offline" });
    expect(calls).toEqual([]);
  });

  it("keeps the built-in release when nothing is published", async () => {
    const cache = memoryCache();
    const result = await service(cache, study({ pointer: null }).transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "nothing_published" });
    expect(result.activeHash).toBe(BUILT_IN_HASH);
    // And it is remembered for the handover panel.
    expect(cache.current?.lastResult).toEqual(result.record);
  });

  it("takes a newly published release once it has proved itself, and keeps it for next time", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    const { transport, calls } = study({
      pointer: pointerDoc(next.hash),
      releases: { [next.hash.slice(7)]: releaseDoc(next.hash, next.json) },
    });
    const releases = service(cache, transport);

    const result = await releases.refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "activated", hash: next.hash, version: "7.2.0" });
    expect(result.activeHash).toBe(next.hash);
    expect(cache.current?.activeHash).toBe(next.hash);
    // Stored as the exact string, so it can be verified again when read back.
    expect(cache.rows.get(next.hash)?.json).toBe(next.json);
    expect(calls).toHaveLength(2);

    // Downloaded in this session…
    expect((await releases.releaseForHash(next.hash))?.source).toBe("live");
    // …and after a restart, with no network at all.
    const offline = service(cache, undefined, { online: false });
    const startup = await offline.resolveStartupRelease();
    expect(startup.hash).toBe(next.hash);
    expect(startup.source).toBe("cached");

    // A second look finds nothing new, and downloads nothing.
    const again = await releases.refreshActiveRelease();
    expect(again.record.outcome).toEqual({ kind: "up_to_date", hash: next.hash, version: "7.2.0" });
    expect(calls).toHaveLength(3);
  });

  it("keeps what it has when the network fails", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    await service(cache).cacheRelease(next.json, next.hash);
    await cache.saveState({ activeHash: next.hash });
    const dropped = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await service(cache, dropped).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "unreachable", reason: "Failed to fetch" });
    expect(result.activeHash).toBe(next.hash);
    expect(cache.current?.activeHash).toBe(next.hash);
  });

  it("refuses a tampered release and keeps what it has", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    const tampered = next.json.replace("Published from the Studio", "Something nobody approved");
    const { transport } = study({
      pointer: pointerDoc(next.hash),
      releases: { [next.hash.slice(7)]: releaseDoc(next.hash, tampered) },
    });
    const result = await service(cache, transport).refreshActiveRelease();
    expect(result.record.outcome).toMatchObject({ kind: "refused", hash: next.hash });
    expect(result.activeHash).toBe(BUILT_IN_HASH);
    expect(cache.rows.size).toBe(0);
    expect(cache.current?.activeHash ?? null).toBeNull();
  });

  it("does not download a release the pointer says this build cannot render", async () => {
    const { transport, calls } = study({
      pointer: pointerDoc(`sha256:${"b".repeat(64)}`, { engineVersion: { stringValue: "9.0.0" } }),
    });
    const result = await service(memoryCache(), transport).refreshActiveRelease();
    expect(result.record.outcome).toMatchObject({ kind: "refused", reason: expect.stringMatching(/engine 9\.0\.0/) });
    expect(calls).toHaveLength(1);
  });

  it("refuses a release stored under a hash other than the one it is fetched by", async () => {
    const next = await nextRelease();
    const { transport } = study({
      pointer: pointerDoc(next.hash),
      releases: { [next.hash.slice(7)]: releaseDoc(BUILT_IN_HASH, next.json) },
    });
    const result = await service(memoryCache(), transport).refreshActiveRelease();
    expect(result.record.outcome).toMatchObject({ kind: "refused", reason: expect.stringMatching(/different hash/) });
  });

  it("does not make a release active that it could not store", async () => {
    // A sitting started under a release this device cannot read back could not
    // be resumed, so an unstorable release is not used at all.
    const next = await nextRelease();
    const cache = memoryCache();
    cache.put = async () => {
      throw new Error("QuotaExceededError");
    };
    const { transport } = study({
      pointer: pointerDoc(next.hash),
      releases: { [next.hash.slice(7)]: releaseDoc(next.hash, next.json) },
    });
    const result = await service(cache, transport).refreshActiveRelease();
    expect(result.record.outcome.kind).toBe("failed");
    expect(result.activeHash).toBe(BUILT_IN_HASH);
  });

  it("rolls back to the built-in release without downloading anything", async () => {
    const next = await nextRelease();
    const cache = memoryCache();
    await service(cache).cacheRelease(next.json, next.hash);
    await cache.saveState({ activeHash: next.hash });
    const { transport, calls } = study({ pointer: pointerDoc(BUILT_IN_HASH, { version: { stringValue: "7.3.0" } }) });

    const result = await service(cache, transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "activated", hash: BUILT_IN_HASH, version: "7.3.0" });
    expect(result.activeHash).toBe(BUILT_IN_HASH);
    expect(calls).toHaveLength(1);
  });

  it("downloads a release pruned while the app was open again, rather than activating it from memory", async () => {
    // A goes live, then B; with no sitting left under A the device prunes it. The
    // study then rolls back to A. Activating A from what this page remembered
    // would start sittings under a release the device no longer holds: the next
    // launch would open on the built-in release and could not resume them.
    const a = await nextRelease();
    const b = await derived((body) => {
      body["release"]["version"] = "7.3.0";
      body["release"]["key"] = "ybm_nd2026_standard_r7_3_0";
      body["composition"]["studyLabel"] = "Published again";
    });
    const docs: { pointer: Json | null; releases: Record<string, Json> } = {
      pointer: pointerDoc(a.hash),
      releases: {
        [a.hash.slice(7)]: releaseDoc(a.hash, a.json),
        [b.hash.slice(7)]: releaseDoc(b.hash, b.json),
      },
    };
    const { transport, calls } = study(docs);
    const cache = memoryCache();
    const releases = service(cache, transport);

    expect((await releases.refreshActiveRelease()).activeHash).toBe(a.hash);
    docs.pointer = pointerDoc(b.hash);
    expect((await releases.refreshActiveRelease()).activeHash).toBe(b.hash);

    cache.rows.delete(a.hash); // what pruneCachedReleases does
    expect(await releases.releaseForHash(a.hash)).toBeNull();

    docs.pointer = pointerDoc(a.hash);
    const before = calls.length;
    const back = await releases.refreshActiveRelease();
    expect(back.record.outcome).toMatchObject({ kind: "activated", hash: a.hash });
    expect(calls.slice(before)).toEqual([`${SOURCE}/published/${SURVEY}`, `${SOURCE}/publicReleases/${a.hash.slice(7)}`]);
    expect(cache.rows.get(a.hash)?.json).toBe(a.json);
    // And so the next launch, offline, opens on it.
    const startup = await service(cache, undefined, { online: false }).resolveStartupRelease();
    expect(startup.hash).toBe(a.hash);
  });

  it("asks once when several screens ask at the same moment", async () => {
    const { transport, calls } = study({ pointer: null });
    const releases = service(memoryCache(), transport);
    const [a, b] = await Promise.all([releases.refreshActiveRelease(), releases.refreshActiveRelease()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("says what happened in words a researcher can act on", () => {
    expect(describeCheck({ kind: "up_to_date", hash: BUILT_IN_HASH, version: "7.3.0" })).toBe("up to date.");
    expect(describeCheck({ kind: "refused", hash: BUILT_IN_HASH, version: "8.0.0", reason: "it needs survey engine 9.0.0" })).toMatch(
      /\(8\.0\.0\) was not used, because it needs survey engine 9\.0\.0/,
    );
    expect(describeCheck({ kind: "not_configured" })).toMatch(/does not look/);
  });
});

describe("which sitting a code resumes", () => {
  const row = (sessionId: string, releaseHash: string, updatedAt: string, state: SessionRow["state"] = "in_progress"): SessionRow => ({
    sessionId,
    participantCode: "NDC0042",
    releaseKey: "k",
    releaseHash,
    state,
    currentIndex: 7,
    startedAt: "2026-09-28T09:00:00.000Z",
    updatedAt,
    eventCount: 10,
  });
  const OLD = BUILT_IN_HASH;
  const NEW = `sha256:${"c".repeat(64)}`;
  const rows = [
    row("ses_old", OLD, "2026-09-28T10:00:00.000Z"),
    row("ses_older_new", NEW, "2026-09-28T09:30:00.000Z"),
    row("ses_done", NEW, "2026-09-28T11:00:00.000Z", "awaiting_sync"),
  ];

  it("is the newest unfinished one whatever release it started under", () => {
    // Yesterday's r7.1.0 sitting is still that participant's sitting after a new
    // version arrives, and is resumed under r7.1.0.
    expect(pickResumable(rows, { anyRelease: true })?.sessionId).toBe("ses_old");
  });

  it("can still be restricted to one release, which is the fallback", () => {
    expect(pickResumable(rows, { releaseHash: NEW })?.sessionId).toBe("ses_older_new");
    expect(pickResumable(rows, { releaseHash: `sha256:${"d".repeat(64)}` })).toBeUndefined();
  });
});

/**
 * The release a resumed sitting is drawn with (App's Start, through lib/resume.ts).
 *
 * The case that matters is the one that only happens when something has already
 * gone wrong: a sitting whose release this device cannot open. It must never be
 * drawn with the release on screen — its saved position would land on a different
 * question — so it is left alone and the old same-release rule applies.
 */
describe("which release a resumed sitting is drawn with", () => {
  const row = (sessionId: string, releaseHash: string, updatedAt: string): SessionRow => ({
    sessionId,
    participantCode: "NDC0042",
    releaseKey: "k",
    releaseHash,
    state: "in_progress",
    currentIndex: 7,
    startedAt: "2026-09-28T09:00:00.000Z",
    updatedAt,
    eventCount: 10,
  });

  /** The device's rows for the code, and the releases it can open. */
  function device(rows: SessionRow[], held: Record<string, LoadedRelease | Error>): ResumeLookup {
    return {
      find: async (_code, scope) => pickResumable(rows, scope),
      releaseForHash: async (hash) => {
        const found = held[hash];
        if (found instanceof Error) throw found;
        return found ?? null;
      },
    };
  }

  it("draws the newest unfinished sitting with its own release, not the one on screen", async () => {
    const next = await nextRelease();
    const verified = await verifyRelease(next.json, next.hash);
    if (!verified.ok) throw new Error(verified.reason);
    const onScreen = buildRuntime(verified.manifest, "cached");
    const old = row("ses_old", BUILT_IN_HASH, "2026-09-28T10:00:00.000Z");

    const chosen = await sittingToResume("NDC0042", onScreen, device([old], { [BUILT_IN_HASH]: BUILT_IN }));
    expect(chosen.session?.sessionId).toBe("ses_old");
    expect(chosen.runtime.hash).toBe(BUILT_IN_HASH);
    expect(chosen.runtime).not.toBe(onScreen);
    // Drawn with that release's content, not the newer one on screen.
    expect(onScreen.manifest.composition.studyLabel).toBe("Published from the Studio");
    expect(chosen.runtime.manifest.composition.studyLabel).toBe(BUILT_IN.manifest.composition.studyLabel);
  });

  it("keeps the release on screen when the sitting was started under it", async () => {
    const onScreen = buildRuntime(BUILT_IN.manifest);
    const lookup = device([row("ses_same", BUILT_IN_HASH, "2026-09-28T10:00:00.000Z")], {});
    const chosen = await sittingToResume("NDC0042", onScreen, lookup);
    expect(chosen).toEqual({ session: expect.objectContaining({ sessionId: "ses_same" }), runtime: onScreen });
    expect(chosen.runtime).toBe(onScreen);
  });

  it("falls back to the old same-release rule when the sitting's release cannot be opened", async () => {
    const onScreen = buildRuntime(BUILT_IN.manifest);
    const missing = `sha256:${"e".repeat(64)}`;
    const rows = [
      row("ses_unopenable", missing, "2026-09-28T11:00:00.000Z"),
      row("ses_on_screen", BUILT_IN_HASH, "2026-09-28T09:00:00.000Z"),
    ];
    // Not held at all, and a cache that throws: both leave the sitting alone.
    for (const held of [{}, { [missing]: new Error("IndexedDB went away") }]) {
      const chosen = await sittingToResume("NDC0042", onScreen, device(rows, held));
      expect(chosen.session?.sessionId).toBe("ses_on_screen");
      expect(chosen.runtime).toBe(onScreen);
    }
    // With no sitting of the release on screen, a new sitting is started instead.
    const alone = await sittingToResume("NDC0042", onScreen, device([rows[0]!], {}));
    expect(alone).toEqual({ session: undefined, runtime: onScreen });
  });

  it("never pairs a sitting with a release whose hash is not the sitting's", async () => {
    // A cache that answered for one hash with another release's manifest.
    const onScreen = buildRuntime(BUILT_IN.manifest);
    const next = await nextRelease();
    const verified = await verifyRelease(next.json, next.hash);
    if (!verified.ok) throw new Error(verified.reason);
    const wrong: LoadedRelease = { manifest: verified.manifest, hash: next.hash, source: "cached" };
    const asked = `sha256:${"f".repeat(64)}`;
    const chosen = await sittingToResume(
      "NDC0042",
      onScreen,
      device([row("ses_x", asked, "2026-09-28T11:00:00.000Z")], { [asked]: wrong }),
    );
    expect(chosen).toEqual({ session: undefined, runtime: onScreen });
  });
});

describe("which downloaded releases a device may forget", () => {
  it("keeps every release a sitting on the device, or the screen, still needs", () => {
    const needed = new Set(["sha256:a", "sha256:b"]);
    expect(releasesToPrune(["sha256:a", "sha256:b", "sha256:c"], needed)).toEqual(["sha256:c"]);
    expect(releasesToPrune([], needed)).toEqual([]);
  });
});
