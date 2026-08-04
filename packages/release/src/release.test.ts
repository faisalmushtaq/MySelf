import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allInstruments, allModules, allScales } from "@myself/library";
import { microNarrativeFull, type NarrativeProtocol } from "@myself/narrative";
import { allScoring } from "@myself/scoring";
import { buildRelease, PublishGateError, verifyManifestHash, type Registries } from "./builder.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { ybmComposition } from "./compose-ybm.js";

const registries: Registries = {
  instruments: allInstruments,
  modules: allModules,
  scales: allScales,
  scoring: allScoring,
};

const meta = {
  version: "7.0.0",
  publishedAt: "2026-08-03T18:00:00.000Z",
  publishedBy: "faisalmushtaq",
  engineVersion: "0.1.0",
  decisionRefs: ["D-09", "D-23", "D-35", "D-37"],
};

describe("canonical JSON", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  });

  it("hash changes on any value change", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("YBM release r7.0.0", () => {
  it("passes the publish gate and produces a verifiable manifest", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    expect(manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyManifestHash(manifest)).toBe(true);
    expect(manifest.release.key).toBe("ybm_nd2026_standard_r7_0_0");
  });

  it("is deterministic: identical inputs give an identical hash", () => {
    const a = buildRelease(ybmComposition, registries, meta);
    const b = buildRelease(ybmComposition, registries, meta);
    expect(a.hash).toBe(b.hash);
  });

  it("freezes every component of the composition and its scales/scoring", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    // 18 since r6.0.0: the two sleep-priority questions were dropped from this
    // fielding (D-31), so their module is no longer a component.
    expect(Object.keys(manifest.instruments)).toHaveLength(18);
    expect(Object.keys(manifest.instruments).some((k) => k.includes("sleep_priorities"))).toBe(false);
    // canonical (variant-less) forms only (D-08)
    for (const key of Object.keys(manifest.instruments)) expect(key).not.toContain("+ybm-asadmin");
    expect(Object.keys(manifest.scoring)).toEqual(
      expect.arrayContaining(["score.sdq25_s", "score.rcads25", "score.swemwbs", "score.stai5", "score.bisbas12_ybm", "score.ehi_sf"]),
    );
    expect(Object.keys(manifest.scales).length).toBeGreaterThanOrEqual(25);
  });

  it("matches the manifest committed to releases/ — a published release never drifts", () => {
    // The frozen file is what devices actually run. If someone edits an item,
    // a scale or the composition without republishing, this fails: the release
    // on disk would no longer be the release the sources describe.
    const path = fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8")) as {
      hash: string;
      release: { version: string; publishedAt: string; publishedBy: string; engineVersion: string; decisionRefs: string[] };
    };
    expect(verifyManifestHash(committed as never)).toBe(true);
    // Rebuilt with the release's own publication metadata, so only a change to
    // the instruments, scales, scoring or composition can move the hash.
    const rebuilt = buildRelease(ybmComposition, registries, {
      version: committed.release.version,
      publishedAt: committed.release.publishedAt,
      publishedBy: committed.release.publishedBy,
      engineVersion: committed.release.engineVersion,
      decisionRefs: committed.release.decisionRefs,
    });
    expect(rebuilt.hash).toBe(committed.hash);
  });

  it("tampering with a frozen manifest invalidates its hash", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    const tampered = structuredClone(manifest);
    (tampered.composition.sections[0]!.title as string) = "Tampered";
    expect(verifyManifestHash(tampered)).toBe(false);
  });
});

describe("publish gate", () => {
  it("rejects an unresolved instrument reference", () => {
    const bad = structuredClone(ybmComposition);
    bad.sections[3]!.components.push({
      kind: "instrument",
      ref: { instrument: "psqi", version: "1.0", language: "en-GB", informant: "self", readingLevel: "standard" },
    });
    expect(() => buildRelease(bad, registries, meta)).toThrow(PublishGateError);
    expect(() => buildRelease(bad, registries, meta)).toThrow(/unresolved instrument reference 'psqi@1.0'/);
  });

  it("rejects a licence-blocked instrument", () => {
    const blockedRegistries = structuredClone(registries);
    const sdq = blockedRegistries.instruments.find((i) => i.instrument === "sdq25_s")!;
    sdq.licence.status = "permission_required";
    expect(() => buildRelease(ybmComposition, blockedRegistries, meta)).toThrow(/licence gate: 'sdq25_s'/);
  });

  it("rejects a missing form variant", () => {
    const bad = structuredClone(ybmComposition);
    bad.sections[3]!.components[0] = {
      kind: "instrument",
      ref: { instrument: "kss", version: "1.0", variant: "nonexistent", language: "en-GB", informant: "self", readingLevel: "standard" },
    };
    expect(() => buildRelease(bad, registries, meta)).toThrow(/no form of 'kss@1.0' matches/);
  });

  it("rejects duplicate variables introduced across components", () => {
    const dupRegistries = structuredClone(registries);
    const gaming = dupRegistries.modules.find((m) => m.instrument === "ybm_gaming")!;
    // Sabotage: give a gaming item a variable owned by the smartphone module
    gaming.forms[0]!.items[0]!.variable = "sm_use";
    expect(() => buildRelease(ybmComposition, dupRegistries, meta)).toThrow(/duplicate variable 'sm_use'/);
  });

  it("rejects a question that branches on an answer given later", () => {
    // The condition would be evaluated against an empty answer, so the item
    // would vanish from every session and nobody would notice until the data
    // came back short. That is a broken release, not a runtime problem.
    const bad = structuredClone(registries);
    const identity = bad.modules.find((m) => m.instrument === "ybm_identity")!;
    identity.forms[0]!.items[0]!.displayIf = {
      op: "selected",
      target: { item: { instrument: "ybm_smartphone", item: "sm_use", revision: 1 } },
      code: 1,
    };
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/asked later/);
  });

  it("rejects a cross-check against a question that does not exist", () => {
    const bad = structuredClone(registries);
    const identity = bad.modules.find((m) => m.instrument === "ybm_identity")!;
    const month = identity.forms[0]!.items.find((i) => i.key === "ps_birth_month")!;
    month.crossChecks = [
      {
        kind: "matches_month_of_date",
        against: { instrument: "ybm_identity", item: "nonexistent", revision: 1 },
        message: "…",
      },
    ];
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/not in this release/);
  });

  it("rejects an option limit derived from a date collected afterwards", () => {
    const bad = structuredClone(registries);
    const identity = bad.modules.find((m) => m.instrument === "ybm_identity")!;
    // Move date of birth to the end of the module, after the month it feeds
    const items = identity.forms[0]!.items;
    const dob = items.splice(items.findIndex((i) => i.key === "dob"), 1)[0]!;
    items.push(dob);
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/asked later/);
  });

  it("rejects an undeclared pipe placeholder", () => {
    const badRegistries = structuredClone(registries);
    const consent = badRegistries.modules.find((m) => m.instrument === "ybm_intro_consent")!;
    consent.forms[0]!.items[0]!.stem = { text: "Welcome {name}" }; // placeholder without pipe declaration
    expect(() => buildRelease(ybmComposition, badRegistries, meta)).toThrow(/unresolved placeholder '\{name\}'/);
  });
});

describe("placing a narrative protocol in a composition", () => {
  const approved: NarrativeProtocol = { ...microNarrativeFull, approvalStatus: "approved" };
  const withNarrative = structuredClone(ybmComposition);
  withNarrative.sections.push({
    key: "mystory",
    title: "MyStory",
    transition: "One last part — a short conversation.",
    components: [
      { kind: "narrative", protocol: approved.key, protocolVersion: approved.version },
    ],
  });
  const registriesWithProtocol: Registries = { ...registries, narrativeProtocols: [approved] };

  it("freezes the protocol, its assembled prompts and its model configs", () => {
    const manifest = buildRelease(withNarrative, registriesWithProtocol, meta);
    expect(manifest.narrativeProtocols[`${approved.key}@${approved.version}`]).toBeDefined();
    // What went to the provider is answerable from the release alone, without
    // re-deriving it from a template and a config that have both moved on.
    const interviewer = manifest.prompts[`pt.interviewer@${approved.version}`] as { system: string };
    expect(interviewer.system).toContain(approved.interview!.persona);
    expect(interviewer.system).toContain("1. Can you tell me about a time recently");
    // One frozen prompt per persona: which one wrote a retelling is a fact.
    expect(manifest.prompts[`pt.scenario.0@${approved.version}`]).toBeDefined();
    expect(manifest.prompts[`pt.scenario.2@${approved.version}`]).toBeDefined();
    expect(manifest.modelConfigs["mc.openai.gpt4o.t07"]).toMatchObject({ model: "gpt-4o", temperature: 0.7 });
  });

  it("leaves session variables standing rather than pretending to know them", () => {
    const manifest = buildRelease(withNarrative, registriesWithProtocol, meta);
    const interviewer = manifest.prompts[`pt.interviewer@${approved.version}`] as { system: string };
    expect(interviewer.system).toContain("{topic}");
  });

  it("changes the release hash when the protocol changes", () => {
    // A protocol edit is a different study. If the hash did not move, two
    // fieldings running different questions would be indistinguishable later.
    const a = buildRelease(withNarrative, registriesWithProtocol, meta);
    const edited: NarrativeProtocol = {
      ...approved,
      interview: { ...approved.interview!, questions: ["Tell me about school."] },
    };
    const b = buildRelease(withNarrative, { ...registries, narrativeProtocols: [edited] }, meta);
    expect(a.hash).not.toBe(b.hash);
  });

  it("refuses a protocol the composition names but nobody supplied", () => {
    expect(() => buildRelease(withNarrative, registries, meta)).toThrow(/unresolved narrative protocol/);
  });

  it("refuses a protocol that has not been approved", () => {
    expect(() => buildRelease(withNarrative, { ...registries, narrativeProtocols: [microNarrativeFull] }, meta)).toThrow(
      /is 'draft' — only an approved protocol can be fielded/,
    );
  });

  it("runs the protocol's own gate, so a leaked name cannot reach a release", () => {
    const leaky: NarrativeProtocol = {
      ...approved,
      permittedVariables: ["first_name", "topic"],
      permittedIdentifiers: [],
      interview: { ...approved.interview!, questions: ["Hi {first_name}, what happened?"] },
    };
    expect(() => buildRelease(withNarrative, { ...registries, narrativeProtocols: [leaky] }, meta)).toThrow(
      /not listed in permittedIdentifiers/,
    );
  });

  it("refuses a protocol that pauses offline in a composition promising otherwise", () => {
    const offlineDraft = structuredClone(withNarrative);
    offlineDraft.offline.narrativeConnectivity = "offline_capable_with_queue";
    const pausing: NarrativeProtocol = { ...approved, offlineFallback: "pause_module" };
    expect(() => buildRelease(offlineDraft, { ...registries, narrativeProtocols: [pausing] }, meta)).toThrow(
      /pauses when offline/,
    );
  });

  it("leaves a release without a narrative section untouched", () => {
    const manifest = buildRelease(ybmComposition, registriesWithProtocol, meta);
    expect(manifest.narrativeProtocols).toEqual({});
    expect(manifest.prompts).toEqual({});
  });
});
