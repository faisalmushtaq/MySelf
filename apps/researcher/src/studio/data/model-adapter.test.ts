import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, type StudioDraft, type VersionDoc } from "@myself/studio";
import { releaseManifest } from "@myself/schema";
import { describeAudit } from "../shell/common.js";
import { buildPublishedContext } from "./hooks.js";
import { diffDrafts, manifestIndex, publishedScaleCodes, reservedFrom } from "./model-adapter.js";
import type { LoadedRelease } from "./releases.js";

/**
 * The TEMPORARY fallbacks behind the model adapter, and what the platform
 * builds from them. When the adapter is switched to @myself/studio's own
 * diff and history modules these should still pass: they only pin behaviour
 * any correct implementation has.
 */

const load = (v: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../../../releases/ybm_nd2026_standard_r${v}.manifest.json`), "utf8")) as {
    hash: string;
    release: { version: string; key: string };
  };
const r710 = load("7.1.0");
const r701 = load("7.0.1");

describe("the diff behind the adapter", () => {
  it("finds nothing between a release and itself", () => {
    const summary = diffDrafts(extractDraft(r710), extractDraft(r710));
    expect(summary.entries).toEqual([]);
    expect(summary.bump).toBeNull();
  });

  it("names a changed question and calls a wording change major", () => {
    const before = extractDraft(r710);
    const after: StudioDraft = structuredClone(before);
    const def = Object.values(after.instruments)[0]!;
    const item = (def.forms[0]!.items as { key: string; stem: { text: string } }[])[0]!;
    item.stem = { text: `${item.stem.text} (reworded)` };
    const summary = diffDrafts(before, after);
    const changed = summary.entries.find((e) => e.kind === "question.changed");
    expect(changed?.aspects).toContain("wording");
    expect(summary.bump).toBe("major");
  });

  it("treats everything as added when nothing was published before", () => {
    const summary = diffDrafts(null, extractDraft(r710));
    expect(summary.counts.added).toBeGreaterThan(100);
  });
});

describe("what has been published", () => {
  it("indexes a release's question IDs and variables", () => {
    const index = manifestIndex(releaseManifest.parse(r710));
    expect(index.itemKeys.length).toBe(147);
    expect(new Set(index.itemKeys).size).toBe(index.itemKeys.length);
    // Aligned, as the real ManifestIndex promises: variables[i] is the column
    // itemKeys[i] was recorded under, which reservedFrom pairs index by index.
    expect(index.variables.length).toBe(index.itemKeys.length);
    // kss.q1 is recorded as kss_q1 in r7.1.0's manifest.
    const kss = index.itemKeys.indexOf("kss.q1");
    expect(kss).toBeGreaterThanOrEqual(0);
    expect(index.variables[kss]).toBe("kss_q1");
  });

  it("reserves every ID and variable any version used", () => {
    const reserved = reservedFrom([
      { itemKeys: ["a.q1"], variables: ["q1"] },
      { itemKeys: ["a.q2"], variables: ["q2"] },
    ]);
    expect([...reserved.itemKeys]).toEqual(["a.q1", "a.q2"]);
    expect([...reserved.variables]).toEqual(["q1", "q2"]);
  });

  it("collects the option codes of every scale across versions", () => {
    const codes = publishedScaleCodes([releaseManifest.parse(r701), releaseManifest.parse(r710)]);
    expect(codes.size).toBeGreaterThan(0);
    for (const m of codes.values()) for (const [code, label] of m) expect(typeof code === "number" && typeof label === "string").toBe(true);
  });

  it("builds the published context from the live release and every version", () => {
    const release = (raw: typeof r710): LoadedRelease => ({ hash: raw.hash, json: JSON.stringify(raw), raw, manifest: releaseManifest.parse(raw) });
    const releases = new Map([r701, r710].map((r) => [r.hash, release(r)]));
    const version = (raw: typeof r710): VersionDoc => {
      const index = manifestIndex(releaseManifest.parse(raw));
      return {
        surveyId: "ybm_nd2026_standard",
        version: raw.release.version,
        hash: raw.hash,
        releaseKey: raw.release.key,
        engineVersion: "0.1.0",
        releaseNote: "",
        changeSummary: null,
        bump: null,
        itemKeys: index.itemKeys,
        variables: index.variables,
        source: "repository",
        draftRevision: null,
        basedOnVersion: null,
        authors: [],
        publishedAt: "2026-09-28T00:00:00Z",
        publishedBy: "x",
        publishedByEmail: null,
        manifestPublishedAt: "2026-09-28T00:00:00Z",
      };
    };
    const survey = {
      surveyId: "ybm_nd2026_standard",
      study: "ybm",
      title: "YBM",
      createdAt: "2026-09-28T00:00:00Z",
      createdBy: "x",
      active: { version: "7.1.0", hash: r710.hash, releaseKey: r710.release.key, generation: 1, publishedAt: "2026-09-28T00:00:00Z", publishedBy: "x", publishedByEmail: null },
      latestVersion: "7.1.0",
      versionCount: 2,
      draftEditors: [],
    };
    const ctx = buildPublishedContext(survey, [version(r710), version(r701)], releases);
    expect(ctx.baseline).toEqual(extractDraft(r710));
    expect(ctx.publishedItemKeys.size).toBeGreaterThanOrEqual(147);
    expect(ctx.reserved.itemKeys).toEqual(ctx.publishedItemKeys);
    expect(ctx.publishedScaleCodes.size).toBeGreaterThan(0);
    // The survey document changing (a save adds to its editors) keeps the same
    // baseline object, so nothing compared with it starts over.
    const again = buildPublishedContext({ ...survey, draftEditors: ["someone@example.org"] }, [version(r710), version(r701)], new Map(releases));
    expect(again.baseline).toBe(ctx.baseline);
    // Nothing published: no baseline, nothing reserved.
    const empty = buildPublishedContext({ ...survey, active: null }, [], new Map());
    expect(empty.baseline).toBeNull();
    expect(empty.reserved.itemKeys.size).toBe(0);
  });
});

describe("the activity log in words", () => {
  const row = (action: string, subject: string, detail: Record<string, unknown> | null = null) =>
    ({ at: "2026-09-28T10:00:00Z", actor: "u", actorEmail: "a@example.org", action, surveyId: "s", subject, detail }) as Parameters<typeof describeAudit>[0];

  it("says who did what, with versions named as people read them", () => {
    expect(describeAudit(row("version.published", "8.0.0"))).toBe("a@example.org published r8.0.0.");
    expect(describeAudit(row("version.activated", "7.0.1", { reason: "Wrong consent text" }))).toBe(
      "a@example.org made r7.0.1 live again: “Wrong consent text”",
    );
    expect(describeAudit(row("access.member_set", "b@example.org", { role: "editor" }))).toBe("a@example.org gave b@example.org the editor role.");
  });

  it("leaves out detail it does not recognise rather than guessing", () => {
    expect(describeAudit(row("access.member_set", "b@example.org", { role: 7 }))).toBe("a@example.org changed b@example.org’s access.");
  });
});
