import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { contentHashAsync, readParticipantLink } from "@myself/schema";
import type { CachedReleaseRow, ReleaseStateRow, SessionRow } from "./lib/db.js";
import { choiceOfRow, pickResumable } from "./lib/db.js";
import { BUILT_IN, describeCheck, releaseService, verifyRelease, type ReleaseCache } from "./lib/releases.js";
import { planLink, sourceFor, stateKeyFor, verdictOf } from "./lib/selection.js";

/**
 * Which survey of which study an iPad runs (D-56, docs/16 §11.3).
 *
 * Each test is a way a sitting could land in a study nobody chose: a link
 * followed twice and undoing a change staff made, a survey with nothing to run
 * drawn with the default's questions, a closed or unknown study taken for an
 * open one, a returning participant put back into another study's
 * questionnaire. The network and the cache are stand-ins, as in releases.test.
 */

const DEFAULTS = { study: "ybm", surveyId: "ybm_nd2026_standard" };
const FUTURE = { study: "future", surveyId: "future_main" };
const STUDIES = "https://firestore.example.test/v1/projects/p/databases/(default)/documents/studies";
const SOURCE = `${STUDIES}/future`;

const BUILT_IN_TEXT = readFileSync(
  fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json", import.meta.url)),
  "utf8",
);

type Json = Record<string, any>; // Deliberately loose: the tests write manifests as a publisher would.

/** The built-in release, republished as the first version of another study's survey. */
async function futureRelease(study = "future"): Promise<{ json: string; hash: string }> {
  const { hash: _old, ...body } = JSON.parse(BUILT_IN_TEXT) as Json;
  body["release"]["version"] = "1.0.0";
  body["release"]["key"] = "future_main_r1_0_0";
  body["release"]["assessment"] = "future_main";
  body["release"]["study"] = study;
  body["composition"]["key"] = "future_main";
  body["composition"]["study"] = study;
  body["composition"]["title"] = "Perspectives of the future";
  const hash = await contentHashAsync(body);
  return { json: JSON.stringify({ ...body, hash }), hash };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
const studyDoc = (status: string, title = "Perspectives of the future") => ({
  name: "projects/p/databases/(default)/documents/studies/future",
  fields: { status: { stringValue: status }, title: { stringValue: title } },
});
const pointerDoc = (hash: string) => ({
  name: "projects/p/databases/(default)/documents/studies/future/published/future_main",
  fields: { hash: { stringValue: hash }, version: { stringValue: "1.0.0" }, engineVersion: { stringValue: "0.2.0" } },
});

/** Firestore's REST API for one study: its registry document, its pointer, its releases. */
function rest(options: { registry?: Json | "unreachable" | null; pointer?: Json | null; releases?: Record<string, string> }) {
  const calls: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === SOURCE) {
      if (options.registry === "unreachable") return new Response("Service Unavailable", { status: 503 });
      return options.registry ? json(options.registry) : notFound();
    }
    if (url === `${SOURCE}/published/future_main`) return options.pointer ? json(options.pointer) : notFound();
    const hex = url.startsWith(`${SOURCE}/publicReleases/`) ? url.slice(`${SOURCE}/publicReleases/`.length) : null;
    const stored = hex ? options.releases?.[hex] : undefined;
    return stored
      ? json({ name: `x/${hex}`, fields: { hash: { stringValue: `sha256:${hex}` }, manifest: { stringValue: stored } } })
      : notFound();
  });
  return { transport: transport as unknown as typeof fetch, calls };
}

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
        id: "active:future/future_main",
        activeHash: cache.current?.activeHash ?? null,
        checkedAt: cache.current?.checkedAt ?? null,
        lastResult: cache.current?.lastResult ?? null,
        ...patch,
      };
    },
  };
  return cache;
}

/** A survey of another study, as `serviceFor` makes one: no built-in release, its registry required. */
const futureService = (cache: ReleaseCache, transport?: typeof fetch, online = true) =>
  releaseService({
    builtIn: null,
    cache,
    source: SOURCE,
    surveyId: "future_main",
    study: "future",
    registry: "required",
    ...(transport ? { transport } : {}),
    online: () => online,
  });

describe("where a study is read from", () => {
  const config = { surveySource: `${STUDIES}/ybm`, studiesSource: STUDIES, defaultStudy: "ybm" };

  it("keeps the default study's own address, and puts any other under the build's parent", () => {
    expect(sourceFor("ybm", config)).toBe(`${STUDIES}/ybm`);
    expect(sourceFor("future", config)).toBe(`${STUDIES}/future`);
  });

  it("is nowhere for another study when the build was given no parent: it runs only its own survey", () => {
    expect(sourceFor("future", { ...config, studiesSource: "" })).toBe("");
    expect(sourceFor("ybm", { ...config, studiesSource: "" })).toBe(`${STUDIES}/ybm`);
  });

  it("keeps the default survey's release state in the row it always used", () => {
    expect(stateKeyFor(DEFAULTS, DEFAULTS)).toBe("active");
    expect(stateKeyFor(FUTURE, DEFAULTS)).toBe("active:future/future_main");
    expect(stateKeyFor({ study: "ybm", surveyId: "ybm_stage2" }, DEFAULTS)).toBe("active:ybm/ybm_stage2");
  });
});

describe("what the link in the address asks for", () => {
  const reading = (search: string) => readParticipantLink(search, "ybm");

  it("is nothing for the bare address, so an iPad keeps the survey it is on", () => {
    expect(planLink(reading(""), FUTURE, null)).toEqual({ kind: "none" });
  });

  it("is followed when it names another survey", () => {
    expect(planLink(reading("?study=future&survey=future_main"), DEFAULTS, null)).toEqual({ kind: "follow", choice: FUTURE });
  });

  it("is nothing to do when it names the survey the iPad is on", () => {
    expect(planLink(reading("?study=future&survey=future_main"), FUTURE, null).kind).toBe("same");
  });

  it("is not followed a second time, so it cannot undo what staff changed since", () => {
    expect(planLink(reading("?study=future&survey=future_main"), DEFAULTS, "future/future_main")).toEqual({
      kind: "followed",
      choice: FUTURE,
    });
  });

  it("is refused, with the reason, when it is not a link", () => {
    expect(planLink(reading("?study=Future&survey=x"), DEFAULTS, null).kind).toBe("invalid");
  });
});

describe("whether a checked survey can be run", () => {
  it("is ready once its release is live and on the device", () => {
    expect(verdictOf({ kind: "activated", hash: "sha256:x", version: "1.0.0" }, false)).toMatchObject({ kind: "ready", version: "1.0.0" });
    expect(verdictOf({ kind: "up_to_date", hash: "sha256:x", version: "1.0.0" }, false).kind).toBe("ready");
  });

  it("refuses an unknown study, a closed one, an unpublished survey and a release that fails, saying which", () => {
    const refusals = [
      verdictOf({ kind: "study_unknown" }, false),
      verdictOf({ kind: "study_closed", title: "Perspectives" }, false),
      verdictOf({ kind: "nothing_published" }, false),
      verdictOf({ kind: "refused", hash: "sha256:x", version: null, reason: "it was altered" }, false),
      verdictOf({ kind: "not_configured" }, false),
    ];
    expect(refusals.map((r) => r.kind)).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expect(refusals.map((r) => (r.kind === "refused" ? r.reason : ""))).toEqual([
      expect.stringMatching(/no such study/),
      expect.stringMatching(/Perspectives.*closed/),
      expect.stringMatching(/not been published/),
      expect.stringMatching(/it was altered/),
      expect.stringMatching(/only run its own survey/),
    ]);
  });

  it("takes the default as ready with nothing published: it has its built-in release", () => {
    expect(verdictOf({ kind: "nothing_published" }, true).kind).toBe("ready");
    expect(verdictOf({ kind: "not_configured" }, true).kind).toBe("ready");
  });

  it("calls offline and an unreachable study a check not yet made, to be tried again", () => {
    expect(verdictOf({ kind: "offline" }, false).kind).toBe("unreachable");
    expect(verdictOf({ kind: "unreachable", reason: "the study replied 503" }, false)).toMatchObject({
      kind: "unreachable",
      reason: expect.stringMatching(/503/),
    });
  });
});

describe("a survey with no built-in release", () => {
  it("has nothing to show until it has been downloaded, rather than the default's questions", async () => {
    const releases = futureService(memoryCache());
    expect(await releases.resolveStartupRelease()).toBeNull();
    expect(await releases.releaseForHash(BUILT_IN.hash)).toBeNull();
    expect((await releases.activeState()).activeHash).toBeNull();
  });

  it("downloads once online, after its registry says it is open, and then runs offline", async () => {
    const release = await futureRelease();
    const cache = memoryCache();
    const { transport, calls } = rest({
      registry: studyDoc("open"),
      pointer: pointerDoc(release.hash),
      releases: { [release.hash.slice(7)]: release.json },
    });
    const result = await futureService(cache, transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "activated", hash: release.hash, version: "1.0.0" });
    // The registry first, then the pointer, then the release.
    expect(calls).toEqual([SOURCE, `${SOURCE}/published/future_main`, `${SOURCE}/publicReleases/${release.hash.slice(7)}`]);

    const offline = await futureService(cache, undefined, false).resolveStartupRelease();
    expect(offline?.manifest.release).toMatchObject({ study: "future", assessment: "future_main" });
    expect(offline?.source).toBe("cached");
  });

  it("is refused when its study has no registry document: a link never creates a study", async () => {
    const { transport, calls } = rest({ registry: null });
    const result = await futureService(memoryCache(), transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "study_unknown" });
    expect(result.activeHash).toBeNull();
    expect(calls).toEqual([SOURCE]);
  });

  it("says a closed study is closed, and keeps what it already has", async () => {
    const release = await futureRelease();
    const cache = memoryCache();
    await futureService(cache, rest({ registry: studyDoc("open"), pointer: pointerDoc(release.hash), releases: { [release.hash.slice(7)]: release.json } }).transport).refreshActiveRelease();
    const result = await futureService(cache, rest({ registry: studyDoc("closed") }).transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "study_closed", title: "Perspectives of the future" });
    expect(result.activeHash).toBe(release.hash);
    expect(describeCheck(result.record.outcome)).toMatch(/closed.*unfinished ones can still be finished/);
  });

  it("reads anything but exactly 'open' as closed", async () => {
    const result = await futureService(memoryCache(), rest({ registry: studyDoc("Open") }).transport).refreshActiveRelease();
    expect(result.record.outcome.kind).toBe("study_closed");
  });

  it("calls an unreadable registry a check not yet made, and asks nothing further", async () => {
    const { transport, calls } = rest({ registry: "unreachable" });
    const result = await futureService(memoryCache(), transport).refreshActiveRelease();
    expect(result.record.outcome.kind).toBe("unreachable");
    expect(calls).toEqual([SOURCE]);
  });

  it("refuses a release filed under it that says it belongs to another study", async () => {
    const elsewhere = await futureRelease("ybm");
    expect(await verifyRelease(elsewhere.json, elsewhere.hash, { surveyId: "future_main", study: "future" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/study 'ybm', not 'future'/),
    });
    const { transport } = rest({ registry: studyDoc("open"), pointer: pointerDoc(elsewhere.hash), releases: { [elsewhere.hash.slice(7)]: elsewhere.json } });
    const result = await futureService(memoryCache(), transport).refreshActiveRelease();
    expect(result.record.outcome.kind).toBe("refused");
    expect(result.activeHash).toBeNull();
  });
});

describe("the default survey's registry", () => {
  const DEFAULT_SOURCE = `${STUDIES}/ybm`;
  const defaultService = (transport: typeof fetch) =>
    releaseService({
      builtIn: BUILT_IN,
      cache: memoryCache(),
      source: DEFAULT_SOURCE,
      surveyId: "ybm_nd2026_standard",
      study: "ybm",
      registry: "optional",
      transport,
      online: () => true,
    });

  it("needs no document, and an unreadable one never stops it from updating", async () => {
    for (const registry of [notFound(), new Response("Service Unavailable", { status: 503 }), new Response("<html>", { status: 200 })]) {
      const calls: string[] = [];
      const transport = vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return String(input) === DEFAULT_SOURCE ? registry.clone() : notFound();
      }) as unknown as typeof fetch;
      const result = await defaultService(transport).refreshActiveRelease();
      expect(result.record.outcome).toEqual({ kind: "nothing_published" });
      expect(result.activeHash).toBe(BUILT_IN.hash);
      expect(calls).toEqual([DEFAULT_SOURCE, `${DEFAULT_SOURCE}/published/ybm_nd2026_standard`]);
    }
  });

  it("is closed only by a document that says so", async () => {
    const transport = vi.fn(async () =>
      json({ name: "projects/p/databases/(default)/documents/studies/ybm", fields: { status: { stringValue: "closed" } } }),
    ) as unknown as typeof fetch;
    const result = await defaultService(transport).refreshActiveRelease();
    expect(result.record.outcome).toEqual({ kind: "study_closed", title: null });
    expect(result.activeHash).toBe(BUILT_IN.hash);
  });
});

describe("which sitting a code resumes, after the iPad has been moved", () => {
  const row = (sessionId: string, updatedAt: string, choice?: { study: string; surveyId: string }): SessionRow => ({
    sessionId,
    participantCode: "P001",
    releaseKey: "k",
    releaseHash: `sha256:${"e".repeat(64)}`,
    state: "in_progress",
    currentIndex: 3,
    startedAt: "2026-10-06T09:00:00.000Z",
    updatedAt,
    eventCount: 5,
    ...(choice ? { study: choice.study, surveyId: choice.surveyId } : {}),
  });

  it("is only one started on the survey the iPad is on, so nobody is put back into another study's questionnaire", () => {
    const rows = [row("ses_future", "2026-10-06T11:00:00.000Z", FUTURE), row("ses_ybm", "2026-10-06T10:00:00.000Z", DEFAULTS)];
    expect(pickResumable(rows, { anyRelease: true, choice: DEFAULTS }, DEFAULTS)?.sessionId).toBe("ses_ybm");
    expect(pickResumable(rows, { anyRelease: true, choice: FUTURE }, DEFAULTS)?.sessionId).toBe("ses_future");
    expect(pickResumable(rows, { anyRelease: true, choice: { study: "ybm", surveyId: "ybm_stage2" } }, DEFAULTS)).toBeUndefined();
  });

  it("counts a sitting from before study spaces as the default's", () => {
    const legacy = row("ses_legacy", "2026-10-06T10:00:00.000Z");
    expect(choiceOfRow(legacy, DEFAULTS)).toEqual(DEFAULTS);
    expect(pickResumable([legacy], { anyRelease: true, choice: DEFAULTS }, DEFAULTS)?.sessionId).toBe("ses_legacy");
    expect(pickResumable([legacy], { anyRelease: true, choice: FUTURE }, DEFAULTS)).toBeUndefined();
  });
});
