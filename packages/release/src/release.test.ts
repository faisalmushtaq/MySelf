import { describe, expect, it } from "vitest";
import { allInstruments, allModules, allScales } from "@myself/library";
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
  version: "3.0.0",
  publishedAt: "2026-08-02T12:00:00.000Z",
  publishedBy: "faisalmushtaq",
  engineVersion: "0.1.0",
  decisionRefs: ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08", "D-09", "D-17", "D-18"],
};

describe("canonical JSON", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  });

  it("hash changes on any value change", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("YBM release r3.0.0", () => {
  it("passes the publish gate and produces a verifiable manifest", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    expect(manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyManifestHash(manifest)).toBe(true);
    expect(manifest.release.key).toBe("ybm_nd2026_standard_r3_0_0");
  });

  it("is deterministic: identical inputs give an identical hash", () => {
    const a = buildRelease(ybmComposition, registries, meta);
    const b = buildRelease(ybmComposition, registries, meta);
    expect(a.hash).toBe(b.hash);
  });

  it("freezes all nine instruments, ten modules and their scales/scoring", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    expect(Object.keys(manifest.instruments)).toHaveLength(19);
    // canonical (variant-less) forms only (D-08)
    for (const key of Object.keys(manifest.instruments)) expect(key).not.toContain("+ybm-asadmin");
    expect(Object.keys(manifest.scoring)).toEqual(
      expect.arrayContaining(["score.sdq25_s", "score.rcads25", "score.swemwbs", "score.stai5", "score.bisbas12_ybm", "score.ehi_sf"]),
    );
    expect(Object.keys(manifest.scales).length).toBeGreaterThanOrEqual(25);
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

  it("rejects narrative components until protocol support lands (explicit failure, not silence)", () => {
    const bad = structuredClone(ybmComposition);
    bad.sections[8]!.components.push({ kind: "narrative", protocol: "np.micro_narrative", protocolVersion: "1.0.0" });
    expect(() => buildRelease(bad, registries, meta)).toThrow(/narrative components not yet supported/);
  });

  it("rejects an undeclared pipe placeholder", () => {
    const badRegistries = structuredClone(registries);
    const consent = badRegistries.modules.find((m) => m.instrument === "ybm_intro_consent")!;
    consent.forms[0]!.items[0]!.stem = { text: "Welcome {name}" }; // placeholder without pipe declaration
    expect(() => buildRelease(ybmComposition, badRegistries, meta)).toThrow(/unresolved placeholder '\{name\}'/);
  });
});
