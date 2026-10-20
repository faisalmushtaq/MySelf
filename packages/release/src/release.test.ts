import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allInstruments, allModules, allScales } from "@myself/library";
import { microNarrativeFull, type NarrativeProtocol } from "@myself/narrative";
import { allScoring, scoringReferenceProblems } from "@myself/scoring";
import { scoringDefinition } from "@myself/schema";
import { releaseAssets } from "./assets.js";
import { buildRelease, PublishGateError, verifyManifestHash, type Registries } from "./builder.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { ybmComposition } from "./compose-ybm.js";

const registries: Registries = {
  instruments: allInstruments,
  modules: allModules,
  scales: allScales,
  scoring: allScoring,
  assets: releaseAssets(),
};

/**
 * The current release.
 *
 * r8.0.0 (D-51) gives each participant the SDQ form published for their age on
 * the day the sitting started: the 11–17 self-report (sdq25_s 2.0, now word for
 * word — items 19, 20 and 22 were the 18+ form's wording) under 18, the 18+
 * self-report (sdq25_s18) from 18. MAJOR: what a participant reads changes.
 * It also replaces the secret code with the home address (D-52), checked
 * against a West Yorkshire postcode list the release pins by hash.
 *
 * r9.0.0 (D-53, D-58): consent that moves on by itself and includes record linkage,
 * ethnic origins in West Yorkshire order, the Sleep Quality Scale, new
 * handedness pictures, checks on social-media answers, and a street search
 * for someone who doesn't know their postcode. MAJOR: all participant-visible.
 *
 * r7.3.0 (D-50) froze the published RCADS-25 key; r7.2.0 (D-49) named the
 * SWEMWBS and STAI-5 items by their real keys.
 */
const meta = {
  version: "9.0.0",
  publishedAt: "2026-09-29T23:02:00.000Z",
  publishedBy: "faisalmushtaq",
  engineVersion: "0.3.0",
  decisionRefs: ["D-53"],
};

describe("canonical JSON", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
  });

  it("hash changes on any value change", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("YBM release r9.0.0", () => {
  it("passes the publish gate and produces a verifiable manifest", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    expect(manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyManifestHash(manifest)).toBe(true);
    expect(manifest.release.key).toBe("ybm_nd2026_standard_r9_0_0");
  });

  it("is deterministic: identical inputs give an identical hash", () => {
    const a = buildRelease(ybmComposition, registries, meta);
    const b = buildRelease(ybmComposition, registries, meta);
    expect(a.hash).toBe(b.hash);
  });

  it("freezes every component of the composition and its scales/scoring", () => {
    const manifest = buildRelease(ybmComposition, registries, meta);
    // 18 from r6.0.0, when the two sleep-priority questions were dropped (D-31);
    // 19 from r8.0.0, when the SDQ became one form for under-18s and one for 18+ (D-51);
    // 20 from r9.0.0, with the Sleep Quality Scale (D-53); 21 with AI chatbot use (D-59).
    expect(Object.keys(manifest.instruments)).toHaveLength(21);
    expect(Object.keys(manifest.instruments).some((k) => k.includes("sleep_priorities"))).toBe(false);
    // canonical (variant-less) forms only (D-08)
    for (const key of Object.keys(manifest.instruments)) expect(key).not.toContain("+ybm-asadmin");
    expect(Object.keys(manifest.scoring)).toEqual(
      expect.arrayContaining(["score.sdq25_s", "score.sdq25_s18", "score.rcads25", "score.swemwbs", "score.stai5", "score.bisbas12_ybm", "score.ehi_sf"]),
    );
    expect(Object.keys(manifest.scales).length).toBeGreaterThanOrEqual(25);
  });

  it("matches the manifest committed to releases/ — a published release never drifts", () => {
    // The frozen file is what devices actually run. If someone edits an item,
    // a scale or the composition without republishing, this fails: the release
    // on disk would no longer be the release the sources describe.
    const path = fileURLToPath(new URL("../../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json", import.meta.url));
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

describe("scoring definitions against the items they score (D-49)", () => {
  it("every definition in the library names only questions its instrument has", () => {
    for (const def of allScoring) {
      const instrument = allInstruments.find((i) => i.instrument === def.instrument && i.version === def.instrumentVersion);
      expect(instrument, def.key).toBeDefined();
      for (const form of instrument!.forms) {
        expect(scoringReferenceProblems(scoringDefinition.parse(def), form.items), `${def.key} / ${form.language}`).toEqual([]);
      }
    }
  });

  it("the publish gate refuses a definition that names a question the form does not have", () => {
    const bad = structuredClone(registries);
    const swemwbs = bad.scoring.find((d) => d.key === "score.swemwbs")!;
    swemwbs.steps = [{ op: "sum", items: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"], output: "raw_total", minValid: 7 }];
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(PublishGateError);
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/scoring definition 'score\.swemwbs': step 1 reads 'q1', which is neither a question of 'swemwbs'/);
  });

  it("every committed release from r7.2.0 scores every definition it freezes; the earlier ones fail only SWEMWBS and STAI-5", () => {
    const dir = fileURLToPath(new URL("../../../releases/", import.meta.url));
    const files = readdirSync(dir).filter((f) => /^ybm_nd2026_standard_r[\d.]+\.manifest\.json$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const f of files) {
      const m = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as {
        release: { version: string };
        scoring: Record<string, unknown>;
        instruments: Record<string, { instrument: string; forms: { items: { key: string; responseType?: string }[] }[] }>;
      };
      const broken = Object.values(m.scoring)
        .map((raw) => scoringDefinition.parse(raw))
        .filter((sd) => {
          const inst = Object.values(m.instruments).find((i) => i.instrument === sd.instrument);
          return inst ? scoringReferenceProblems(sd, inst.forms[0]!.items).length > 0 : true;
        })
        .map((sd) => sd.key)
        .sort();
      const [major, minor] = m.release.version.split(".").map(Number) as [number, number];
      const fixed = major > 7 || (major === 7 && minor >= 2);
      expect(broken, `${m.release.version}`).toEqual(fixed ? [] : ["score.stai5", "score.swemwbs"]);
    }
  });
});

describe("the RCADS-25 key (D-50)", () => {
  const DEPRESSION = ["q1", "q4", "q8", "q10", "q13", "q15", "q16", "q19", "q21", "q24"];
  const itemsOf = (def: { steps: unknown[] }, output: string) =>
    ((def.steps as { output?: string; items?: string[] }[]).find((s) => s.output === output)?.items ?? []).slice().sort();

  it("the library's definition uses the published depression and anxiety items", () => {
    const rcads = scoringDefinition.parse(allScoring.find((d) => d.key === "score.rcads25"));
    expect(itemsOf(rcads, "depression")).toEqual([...DEPRESSION].sort());
    const anxiety = itemsOf(rcads, "anxiety");
    expect(anxiety).toHaveLength(15);
    expect(anxiety).toContain("q18");
    expect(anxiety.some((i) => DEPRESSION.includes(i))).toBe(false);
  });

  it("committed releases from r7.3.0 freeze it; the earlier ones keep the swap of items 18 and 24", () => {
    const dir = fileURLToPath(new URL("../../../releases/", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => /^ybm_nd2026_standard_r[\d.]+\.manifest\.json$/.test(x))) {
      const m = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { release: { version: string }; scoring: Record<string, { steps: unknown[] }> };
      const rcads = m.scoring["score.rcads25"];
      if (!rcads) continue;
      const [major, minor] = m.release.version.split(".").map(Number) as [number, number];
      const fixed = major > 7 || (major === 7 && minor >= 3);
      const depression = itemsOf(rcads, "depression");
      expect(depression.includes("q24"), m.release.version).toBe(fixed);
      expect(depression.includes("q18"), m.release.version).toBe(!fixed);
    }
  });
});

describe("the SDQ by age (D-51)", () => {
  const manifest = buildRelease(ybmComposition, registries, meta);
  const wellbeing = manifest.composition.sections.find((x) => x.key === "wellbeing")!;
  const sdqs = wellbeing.components.filter(
    (c): c is Extract<typeof c, { kind: "instrument" }> => c.kind === "instrument" && c.ref.instrument.startsWith("sdq"),
  );

  it("places the 11–17 and the 18+ forms under complementary conditions on the date of birth", () => {
    const adult = { op: "age_gte", target: { item: { instrument: "ybm_identity", item: "dob", revision: 1 } }, years: 18 };
    expect(sdqs.map((c) => [c.ref.instrument, c.ref.version])).toEqual([
      ["sdq25_s", "2.0"],
      ["sdq25_s18", "1.0"],
    ]);
    expect(sdqs[0]!.displayIf).toEqual({ op: "not", arg: adult });
    expect(sdqs[1]!.displayIf).toEqual(adult);
  });

  it("freezes both forms with their own scoring, and no bands for the 18+", () => {
    const s11 = manifest.instruments["sdq25_s@2.0/en-GB/self/standard"] as { forms: { items: { key: string; stem: { text: string } }[] }[] };
    const s18 = manifest.instruments["sdq25_s18@1.0/en-GB/self/standard"] as typeof s11;
    expect(s11.forms[0]!.items.find((i) => i.key === "q22")!.stem.text).toContain("home, school or elsewhere");
    // the study's adaptation of the S18+ item 22 (D-52)
    expect(s18.forms[0]!.items.find((i) => i.key === "q22")!.stem.text).toContain("home, school or college, university, work or elsewhere");
    const scoring = manifest.scoring["score.sdq25_s18"] as { steps: { op: string }[] };
    expect(scoring.steps).toEqual((manifest.scoring["score.sdq25_s"] as typeof scoring).steps);
    expect(scoring.steps.some((x) => x.op === "classify")).toBe(false);
  });

  it("refuses the age condition when the date of birth is asked after the SDQ", () => {
    const late = structuredClone(ybmComposition);
    const about = late.sections.find((x) => x.key === "about_you")!;
    const identity = about.components.shift()!;
    late.sections.find((x) => x.key === "wellbeing")!.components.push(identity);
    expect(() => buildRelease(late, registries, meta)).toThrow(/sdq25_s18\.q1: component condition depends on 'ybm_identity\.dob', which is asked later/);
  });

  it("releases before r8.0.0 froze the one mixed form", () => {
    const dir = fileURLToPath(new URL("../../../releases/", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => /^ybm_nd2026_standard_r[\d.]+\.manifest\.json$/.test(x))) {
      const m = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { release: { version: string }; instruments: Record<string, unknown> };
      const keys = Object.keys(m.instruments).filter((k) => k.startsWith("sdq"));
      const byAge = Number(m.release.version.split(".")[0]) >= 8;
      expect(keys, m.release.version).toEqual(
        byAge ? ["sdq25_s@2.0/en-GB/self/standard", "sdq25_s18@1.0/en-GB/self/standard"] : ["sdq25_s@1.0/en-GB/self/standard"],
      );
    }
  });
});

describe("the home address instead of a secret code (D-52)", () => {
  const manifest = buildRelease(ybmComposition, registries, meta);
  const identity = manifest.instruments["ybm_identity@1.0/en-GB/self/standard"] as {
    forms: { items: { key: string; identifying?: boolean; responseType: string; postcodeCheck?: { asset: string } }[] }[];
  };
  const items = identity.forms[0]!.items;

  it("asks name, date of birth and address, and no secret code", () => {
    expect(items.map((i) => i.key)).toEqual(["first_name", "last_name", "dob", "home_address"]);
    const address = items.find((i) => i.key === "home_address")!;
    expect(address).toMatchObject({ responseType: "form_fields", identifying: true, postcodeCheck: { asset: "postcodes_west_yorkshire" } });
  });

  it("pins the postcode list it checks against, by hash", () => {
    const pinned = manifest.assets["postcodes_west_yorkshire"]!;
    const file = readFileSync(fileURLToPath(new URL(`../../../${pinned.path}`, import.meta.url)));
    expect(pinned.bytes).toBe(file.length);
    expect(pinned.sha256).toBe(`sha256:${createHash("sha256").update(file).digest("hex")}`);
    // and, from r9.0.0, the street list (D-53)
    expect(Object.keys(manifest.assets).sort()).toEqual(["postcodes_west_yorkshire", "streets_west_yorkshire"]);
  });

  it("refuses to publish an address question whose postcode list it does not have", () => {
    expect(() => buildRelease(ybmComposition, { ...registries, assets: {} }, meta)).toThrow(
      /home_address: postcode list 'postcodes_west_yorkshire' is not among the release's assets/,
    );
  });

  it("tells participants what is collected instead of promising an anonymous code", () => {
    const text = JSON.stringify(manifest.instruments["ybm_intro_consent@1.0/en-GB/self/standard"]);
    expect(text).not.toContain("anonymous code");
    expect(text).not.toContain("SECRET CODE");
    expect(text).toContain("name, date of birth and home address");
    expect(text).toContain("my name, date of birth and address will be kept separately from my answers");
  });
});

describe("shorter consent, sleep quality and sanity checks (D-53)", () => {
  const manifest = buildRelease(ybmComposition, registries, meta);
  type Item = { key: string; responseType: string; [k: string]: unknown };
  const itemsOf = (key: string) => (manifest.instruments[key] as { forms: { items: Item[] }[] }).forms[0]!.items;
  const consent = itemsOf("ybm_intro_consent@1.0/en-GB/self/standard");

  it("consent includes record linkage and moves on by itself (D-58)", () => {
    expect(consent.map((i) => i.key)).toEqual(["intro", "consent", "why_it_matters"]);
    expect(consent.find((i) => i.key === "consent")).toMatchObject({ autoAdvance: true });
    const statements = (consent.find((i) => i.key === "consent") as unknown as { statements: { key: string }[] }).statements;
    expect(statements.map((s) => s.key)).toContain("record_linkage");
    expect(JSON.stringify(manifest)).not.toContain("Citizen Neuroscience");
    expect(consent.find((i) => i.key === "why_it_matters")).toMatchObject({ advanceLabel: "I understand" });
    expect(JSON.stringify(manifest)).not.toContain("m.faizah@");
  });

  it("asks sleep quality before sleepiness", () => {
    const sleep = manifest.composition.sections.find((x) => x.key === "sleep")!;
    expect(sleep.components.map((c) => (c.kind === "instrument" ? c.ref.instrument : c.kind))).toEqual(["sqs", "kss"]);
    const scale = manifest.scales["scale.sqs_0_10"] as { bands: { label: string }[] };
    expect(scale.bands.map((b) => b.label)).toEqual(["Terrible", "Poor", "Fair", "Good", "Excellent"]);
  });

  it("freezes the ethnicity list in its new order with its old codes", () => {
    const eth = manifest.scales["scale.ethnicity_uk20"] as { version: string; options: { code: number }[] };
    expect(eth.version).toBe("2.0.0");
    expect(eth.options.slice(0, 2).map((o) => o.code)).toEqual([13, 2]);
  });

  it("pins the street list it searches, by hash", () => {
    const pinned = manifest.assets["streets_west_yorkshire"]!;
    const file = readFileSync(fileURLToPath(new URL(`../../../${pinned.path}`, import.meta.url)));
    expect(pinned.path).toMatch(/streets-west-yorkshire-\d{4}-\d{2}\.txt$/);
    expect(pinned.bytes).toBe(file.length);
    expect(pinned.sha256).toBe(`sha256:${createHash("sha256").update(file).digest("hex")}`);
  });

  it("refuses a street search whose list, field or postcode check is missing", () => {
    expect(() =>
      buildRelease(ybmComposition, { ...registries, assets: { postcodes_west_yorkshire: registries.assets!["postcodes_west_yorkshire"]! } }, meta),
    ).toThrow(/home_address: street list 'streets_west_yorkshire' is not among the release's assets/);
    const bad = structuredClone(registries);
    const address = bad.modules.find((m) => m.instrument === "ybm_identity")!.forms[0]!.items.find((i) => i.key === "home_address")!;
    if (address.responseType !== "form_fields") throw new Error("wrong type");
    address.streetCheck = { ...address.streetCheck!, areaKey: "house" };
    delete address.postcodeCheck;
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/a street check needs a postcode check beside it/);
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/street check records 'house', which is already a field/);
  });

  it("refuses bands that group numbers the scale does not have", () => {
    const bad = structuredClone(registries);
    const sqs = bad.scales.find((x) => x.key === "scale.sqs_0_10")!;
    sqs.bands = [...sqs.bands!, { label: "Off the scale", from: 10, to: 11 }];
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/band 'Off the scale' covers 11, which is not an option/);
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/10 is in more than one band/);
  });

  it("refuses a confirmation threshold outside the question's range", () => {
    const bad = structuredClone(registries);
    const days = bad.modules.find((m) => m.instrument === "ybm_social_media")!.forms[0]!.items.find((i) => i.key === "abstain_days")!;
    if (days.responseType !== "numeric") throw new Error("wrong type");
    days.confirmAbove = 5000;
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/confirmAbove 5000 is outside the item's range/);
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

  it("never refuses an instrument for its licence status (the team manages licences)", () => {
    const blockedRegistries = structuredClone(registries);
    const sdq = blockedRegistries.instruments.find((i) => i.instrument === "sdq25_s")!;
    sdq.licence.status = "permission_required";
    expect(() => buildRelease(ybmComposition, blockedRegistries, meta)).not.toThrow();
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
    const surname = identity.forms[0]!.items.find((i) => i.key === "last_name")!;
    surname.crossChecks = [
      {
        kind: "matches_month_of_date",
        against: { instrument: "ybm_identity", item: "nonexistent", revision: 1 },
        message: "…",
      },
    ];
    expect(() => buildRelease(ybmComposition, bad, meta)).toThrow(/not in this release/);
  });

  it("rejects an option limit derived from a date collected afterwards", () => {
    // Ask about phones before "About you": the age-of-first-phone options would
    // be limited by a date of birth nobody has given yet.
    const early = structuredClone(ybmComposition);
    const at = early.sections.findIndex((x) => x.key === "phones");
    const [phones] = early.sections.splice(at, 1);
    early.sections.splice(1, 0, phones!);
    expect(() => buildRelease(early, registries, meta)).toThrow(
      /ybm_smartphone\.age_smartphone: option limit 'at_most_age_now' depends on 'ybm_identity\.dob', which is asked later/,
    );
  });

  it("rejects an undeclared pipe placeholder", () => {
    const badRegistries = structuredClone(registries);
    const consent = badRegistries.modules.find((m) => m.instrument === "ybm_intro_consent")!;
    consent.forms[0]!.items[0]!.stem = { text: "Welcome {name}" }; // placeholder without pipe declaration
    expect(() => buildRelease(ybmComposition, badRegistries, meta)).toThrow(/unresolved placeholder '\{name\}'/);
  });
});

describe("placing a narrative protocol in a composition", () => {
  // A release with MyStory needs the engine that sends the module the frozen
  // protocol (docs/16 §10.1).
  const narrativeMeta = { ...meta, engineVersion: "0.4.0" };
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
    const manifest = buildRelease(withNarrative, registriesWithProtocol, narrativeMeta);
    expect(manifest.narrativeProtocols[`${approved.key}@${approved.version}`]).toBeDefined();
    // What went to the provider is answerable from the release alone, without
    // re-deriving it from a template and a config that have both moved on.
    const interviewer = manifest.prompts[`pt.interviewer@${approved.version}`] as { system: string };
    expect(interviewer.system).toContain(approved.interview!.persona);
    expect(interviewer.system).toContain("1. Can you tell me about a time recently");
    // One frozen prompt per persona: which one wrote a retelling is a fact.
    // Keyed by persona name, not by position: which voice wrote a retelling
    // has to survive a later wave reordering the list.
    for (const persona of approved.scenario!.personas) {
      expect(manifest.prompts[`pt.scenario.${persona.key}@${approved.version}`]).toBeDefined();
    }
    expect(manifest.modelConfigs["mc.openai.gpt4o.t07"]).toMatchObject({ model: "gpt-4o", temperature: 0.7 });
  });

  it("leaves session variables standing rather than pretending to know them", () => {
    const manifest = buildRelease(withNarrative, registriesWithProtocol, narrativeMeta);
    const interviewer = manifest.prompts[`pt.interviewer@${approved.version}`] as { system: string };
    expect(interviewer.system).toContain("{topic}");
  });

  it("changes the release hash when the protocol changes", () => {
    // A protocol edit is a different study. If the hash did not move, two
    // fieldings running different questions would be indistinguishable later.
    const a = buildRelease(withNarrative, registriesWithProtocol, narrativeMeta);
    const edited: NarrativeProtocol = {
      ...approved,
      interview: { ...approved.interview!, questions: ["Tell me about school."] },
    };
    const b = buildRelease(withNarrative, { ...registries, narrativeProtocols: [edited] }, narrativeMeta);
    expect(a.hash).not.toBe(b.hash);
  });

  it("refuses a protocol the composition names but nobody supplied", () => {
    expect(() => buildRelease(withNarrative, registries, narrativeMeta)).toThrow(/unresolved narrative protocol/);
  });

  it("refuses a protocol that has not been approved", () => {
    expect(() => buildRelease(withNarrative, { ...registries, narrativeProtocols: [microNarrativeFull] }, narrativeMeta)).toThrow(
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
    expect(() => buildRelease(withNarrative, { ...registries, narrativeProtocols: [leaky] }, narrativeMeta)).toThrow(
      /not listed in permittedIdentifiers/,
    );
  });

  it("refuses a protocol that pauses offline in a composition promising otherwise", () => {
    const offlineDraft = structuredClone(withNarrative);
    offlineDraft.offline.narrativeConnectivity = "offline_capable_with_queue";
    const pausing: NarrativeProtocol = { ...approved, offlineFallback: "pause_module" };
    expect(() => buildRelease(offlineDraft, { ...registries, narrativeProtocols: [pausing] }, narrativeMeta)).toThrow(
      /pauses when offline/,
    );
  });

  it("refuses a release with MyStory that declares an engine without it", () => {
    expect(() => buildRelease(withNarrative, registriesWithProtocol, meta)).toThrow(
      /needs engine 0\.4\.0, but the release declares engine 0\.3\.0/,
    );
  });

  it("leaves a release without a narrative section untouched", () => {
    const manifest = buildRelease(ybmComposition, registriesWithProtocol, meta);
    expect(manifest.narrativeProtocols).toEqual({});
    expect(manifest.prompts).toEqual({});
  });
});
