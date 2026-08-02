import { describe, expect, it } from "vitest";
import { instrumentVersion, moduleDefinition, responseScale } from "@myself/schema";
import { allInstruments } from "./instruments.js";
import { allModules } from "./modules.js";
import { allScales } from "./scales.js";

/**
 * Library-wide validation: every record parses against the schemas, and the
 * cross-record invariants the publish gate depends on hold (unique variables,
 * resolvable scale references, faithful crosswalk pairs).
 */

const parsedScales = allScales.map((s) => responseScale.parse(s));
const parsedInstruments = allInstruments.map((i) => instrumentVersion.parse(i));
const parsedModules = allModules.map((m) => moduleDefinition.parse(m));
const everything = [...parsedInstruments, ...parsedModules];
const scaleKeys = new Set(parsedScales.map((s) => s.key));

describe("scales", () => {
  it("all 34 scales parse", () => {
    expect(parsedScales).toHaveLength(34);
  });

  it("scale keys are unique", () => {
    expect(scaleKeys.size).toBe(parsedScales.length);
  });

  it("canonical codes are unique within each scale", () => {
    for (const s of parsedScales) {
      const codes = s.options.map((o) => o.code);
      expect(new Set(codes).size, s.key).toBe(codes.length);
    }
  });

  it("legacy codes are unique within each scale where present", () => {
    for (const s of parsedScales) {
      const legacy = s.options.map((o) => o.legacyCode).filter((c): c is number => c !== undefined);
      expect(new Set(legacy).size, s.key).toBe(legacy.length);
    }
  });

  it("SDQ and RCADS canonical codings are zero-based with 1-based legacy pairs (A-16)", () => {
    const sdq = parsedScales.find((s) => s.key === "scale.sdq_3pt")!;
    expect(sdq.options.map((o) => [o.code, o.legacyCode])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    const rcads = parsedScales.find((s) => s.key === "scale.rcads_4pt")!;
    expect(rcads.options.map((o) => [o.code, o.legacyCode])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  it("SDQ anchors: canonical 'Certainly True', as-administered 'Clearly true' (A-6)", () => {
    expect(parsedScales.find((s) => s.key === "scale.sdq_3pt")!.options[2]!.label).toBe("Certainly True");
    expect(parsedScales.find((s) => s.key === "scale.sdq_3pt_ybm")!.options[2]!.label).toBe("Clearly true");
  });

  it("age scales include '5' with no legacy code (D-04/A-43) and preserve scrambled legacy maps (A-17)", () => {
    for (const key of ["scale.age_adoption_smartphone", "scale.age_adoption_sm"]) {
      const scale = parsedScales.find((s) => s.key === key)!;
      const five = scale.options.find((o) => o.label === "5")!;
      expect(five.legacyCode, key).toBeUndefined();
      expect(scale.options).toHaveLength(23); // Younger-than-5, 5..25, not sure
    }
    const smartphone7 = parsedScales
      .find((s) => s.key === "scale.age_adoption_smartphone")!
      .options.find((o) => o.label === "7")!;
    expect(smartphone7.legacyCode).toBe(27); // QSF scrambled code preserved
  });

  it("platform scale preserves the legacy gap at 7 (A-15)", () => {
    const platforms = parsedScales.find((s) => s.key === "scale.sm_platforms")!;
    expect(platforms.options.map((o) => o.legacyCode)).not.toContain(7);
    expect(platforms.options.find((o) => o.label === "Twitch")!.legacyCode).toBe(9);
  });

  it("direction metadata is present and deliberate on the reversed pair (A-18)", () => {
    expect(parsedScales.find((s) => s.key === "scale.agree_5pt_desc")!.direction).toBe("descending");
    expect(parsedScales.find((s) => s.key === "scale.doomscroll_7pt")!.direction).toBe("ascending");
  });
});

describe("instruments and modules", () => {
  it("9 instruments and 10 modules parse", () => {
    expect(parsedInstruments).toHaveLength(9);
    expect(parsedModules).toHaveLength(10);
  });

  it("every scale reference resolves", () => {
    for (const inst of everything) {
      for (const form of inst.forms) {
        for (const item of form.items) {
          if ("scale" in item) {
            expect(scaleKeys.has(item.scale), `${inst.instrument}/${item.key} -> ${item.scale}`).toBe(true);
          }
        }
      }
    }
  });

  it("canonical variable names are unique across the whole library (per form set)", () => {
    // Variables repeat across forms of the SAME instrument (canonical vs
    // ybm-asadmin are alternative administrations of the same item), but must
    // never collide across different instruments/modules.
    const owner = new Map<string, string>();
    for (const inst of everything) {
      for (const form of inst.forms) {
        for (const item of form.items) {
          const existing = owner.get(item.variable);
          expect(existing === undefined || existing === inst.instrument, `duplicate variable ${item.variable}`).toBe(
            true,
          );
          owner.set(item.variable, inst.instrument);
        }
      }
    }
  });

  it("legacy variables map to exactly one canonical variable", () => {
    const map = new Map<string, string>();
    for (const inst of everything) {
      for (const form of inst.forms) {
        for (const item of form.items) {
          if (!item.legacyVariable) continue;
          const existing = map.get(item.legacyVariable);
          expect(
            existing === undefined || existing === item.variable,
            `legacy ${item.legacyVariable} maps to both ${existing} and ${item.variable}`,
          ).toBe(true);
          map.set(item.legacyVariable, item.variable);
        }
      }
    }
    // The duplicated Qualtrics 'Introduction' tag (A-32) must NOT be duplicated here
    expect(map.get("Introduction")).toBe("study_intro");
  });

  it("D-08: deviating instruments carry both canonical and ybm-asadmin forms", () => {
    for (const key of ["kss", "ehi_sf", "macarthur_ssy", "sdq25_s"]) {
      const inst = parsedInstruments.find((i) => i.instrument === key)!;
      const variants = inst.forms.map((f) => f.variant);
      expect(variants, key).toContain("ybm-asadmin");
      expect(variants.filter((v) => v === undefined).length, key).toBe(1);
    }
  });

  it("D-05: SDQ and RCADS items are soft-required with decline enabled", () => {
    const sdq = parsedInstruments.find((i) => i.instrument === "sdq25_s")!;
    const rcads = parsedInstruments.find((i) => i.instrument === "rcads25")!;
    for (const form of [...sdq.forms, ...rcads.forms]) {
      for (const item of form.items) {
        expect(item.required).toBe("soft");
        expect(item.allowDecline).toBe(true);
      }
    }
  });

  it("D-02: the Twitch time item conditions on the Twitch platform code", () => {
    const sm = parsedModules.find((m) => m.instrument === "ybm_social_media")!;
    const twitch = sm.forms[0]!.items.find((i) => i.key === "time_twitch")!;
    expect(twitch.displayIf).toMatchObject({ op: "in_group", group: "have", code: 8 });
    const platforms = parsedScales.find((s) => s.key === "scale.sm_platforms")!;
    expect(platforms.options.find((o) => o.code === 8)!.label).toBe("Twitch");
  });

  it("D-03: gaming follow-ups show when 'I do not play video games' is NOT selected", () => {
    const gaming = parsedModules.find((m) => m.instrument === "ybm_gaming")!;
    const topGames = gaming.forms[0]!.items.find((i) => i.key === "top_games")!;
    expect(topGames.displayIf).toMatchObject({ op: "not_selected", code: 1 });
  });

  it("D-01: the abstain-effect item carries the corrected stem", () => {
    const sm = parsedModules.find((m) => m.instrument === "ybm_social_media")!;
    const item = sm.forms[0]!.items.find((i) => i.key === "abstain_effect")!;
    expect(item.stem.text).toContain("abstaining from social media");
    expect(item.stem.text).not.toContain("features designed to reduce");
  });

  it("consent statements all default to required (D-06) and pipe the withdrawal date", () => {
    const consentModule = parsedModules.find((m) => m.instrument === "ybm_intro_consent")!;
    const consent = consentModule.forms[0]!.items.find((i) => i.key === "consent")!;
    if (consent.responseType !== "checkbox_set") throw new Error("wrong type");
    expect(consent.statements).toHaveLength(6);
    for (const s of consent.statements) expect(s.required).toBe(true);
    const withdrawal = consent.statements.find((s) => s.key === "withdrawal_window")!;
    expect(withdrawal.text.pipes?.["withdrawal_date"]).toMatchObject({ kind: "date_offset", offsetDays: 2 });
  });

  it("time estimates carry provenance everywhere", () => {
    for (const inst of everything) {
      expect(inst.timeEstimates.length, inst.instrument).toBeGreaterThan(0);
      for (const t of inst.timeEstimates) expect(t.provenance).toBe("estimated-heuristic");
    }
  });
});
