import { describe, expect, it } from "vitest";
import { ABSOLUTE_MAX_AGE_YEARS, instrumentVersion, itemDefinition, moduleDefinition, responseScale } from "@myself/schema";
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
  it("all 41 scales parse", () => {
    expect(parsedScales).toHaveLength(41);
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

  /**
   * Boundaries. Someone at "exactly 2 hours" must have one box — not two, and
   * not none. The administered scales had both faults: the social-media time
   * bands overlapped at every boundary, and the gaming bands left a hole
   * between 5 and 6 hours. Neither is visible unless you read the options as
   * a set, which is what this does (A-9 / A-36, resolved in D-27).
   */
  describe("quantity bands are unambiguous", () => {
    /**
     * [lower, upper] in minutes, or null when the label states no quantity.
     * The unit is taken from the label as a whole when a part omits it, so
     * "5 to 10 hours" is 300-600 minutes rather than 5-600.
     */
    const parseBand = (label: string): [number, number] | null => {
      if (!/\d/.test(label)) return null;
      const labelUnit = /hour/i.test(label) ? 60 : 1;
      const num = (part: string): number | null => {
        const m = part.match(/(\d+(?:\.\d+)?)/);
        if (!m) return null;
        return Number(m[1]) * (/hour/i.test(part) ? 60 : /minute/i.test(part) ? 1 : labelUnit);
      };
      const parts = label.split(/\bto\b|\bor\b|,|–|—|-/).filter((x) => /\d/.test(x));
      const values = parts.map(num).filter((n): n is number => n !== null);
      if (values.length === 0) return null;

      const openEnded = /(or more|more than|^over)/i.test(label);
      const openStart = /^(less than|under|fewer than|up to|<)/i.test(label);
      // "More than 1 hour, up to 2 hours" states both ends despite opening
      // with "more than", so a second number wins over the open-ended form.
      if (values.length >= 2) return [values[0]!, values[values.length - 1]!];
      if (openStart) return [0, values[0]!];
      if (openEnded) return [values[0]!, Infinity];
      return [values[0]!, values[0]!];
    };

    const banded = [
      "scale.sm_sitting_time_6pt",
      "scale.sm_daily_time_9pt",
      "scale.sm_morning_latency_5pt",
      "scale.sm_night_checks_4pt",
      "scale.gaming_hours_6pt",
      "scale.game_hours_5pt",
    ];

    it.each(banded)("%s: no value falls in two bands, and none falls between them", (key) => {
      const scale = parsedScales.find((s) => s.key === key)!;
      const bands = scale.options
        .filter((o) => o.kind === "substantive")
        .map((o) => ({ label: o.label, band: parseBand(o.label) }))
        .filter((b): b is { label: string; band: [number, number] } => b.band !== null);
      expect(bands.length, `${key} has no parseable bands`).toBeGreaterThan(1);

      for (let i = 1; i < bands.length; i++) {
        const prev = bands[i - 1]!;
        const cur = bands[i]!;
        expect(
          prev.band[1] <= cur.band[0],
          `'${prev.label}' and '${cur.label}' both claim values around ${cur.band[0]} minutes`,
        ).toBe(true);
        // Bands may only be as coarse as the unit they are stated in: whole
        // hours may leave whole-hour steps, minutes may leave minute steps.
        // Anything wider is a range of answers with no box at all.
        const step = /hour/i.test(cur.label) ? 60 : 1;
        expect(
          cur.band[0] - prev.band[1],
          `nothing covers the range between '${prev.label}' and '${cur.label}'`,
        ).toBeLessThanOrEqual(step);
      }
    });

    it("offers no zero band on a question only asked of people who do the thing", () => {
      // "0 minutes" for a platform the participant has just said they use is a
      // contradiction, and tells us nothing we did not already know.
      const sitting = parsedScales.find((s) => s.key === "scale.sm_sitting_time_6pt")!;
      expect(sitting.options.map((o) => o.label)).not.toContain("0 minutes");
    });
  });

  it("direction metadata is present and deliberate on the reversed pair (A-18)", () => {
    expect(parsedScales.find((s) => s.key === "scale.agree_5pt_desc")!.direction).toBe("descending");
    expect(parsedScales.find((s) => s.key === "scale.doomscroll_7pt")!.direction).toBe("ascending");
  });
});

/**
 * Wording that describes a control we do not have, or a page layout that does
 * not exist. These crept in from the Qualtrics original — "drag and drop the
 * apps", "please click", "below are some statements" — and each one is a
 * participant being told to do something impossible (D-29).
 *
 * Canonical forms only: as-administered variants preserve the original
 * wording verbatim on purpose, so they are exempt.
 */
describe("nothing describes an interaction or a layout that is not there", () => {
  const canonicalItems = everything.flatMap((inst) =>
    inst.forms.filter((f) => !f.variant).flatMap((f) => f.items.map((item) => ({ inst: inst.instrument, item }))),
  );

  it.each([
    ["clicking, on a tablet", /\bclick\b/i],
    ["dragging, when the control is tapped", /\bdrag\b/i],
    ["something above or below, when one question fills the screen", /\b(are|is|shown|given|listed|presented)\s+(above|below)\b/i],
    ["ticking or circling a box on paper", /tick the box|check the box|circle (the|one)/i],
    ["a numeric scale the participant does not need to see", /on a scale of/i],
  ])("no stem mentions %s", (_what, pattern) => {
    const offenders = canonicalItems
      .filter(({ item }) => pattern.test(`${item.stem.text} ${item.lede?.text ?? ""}`))
      .map(({ inst, item }) => `${inst}/${item.key}`);
    expect(offenders).toEqual([]);
  });

  it("no two questions ask exactly the same thing", () => {
    // Forms of one questionnaire for age ranges that do not overlap — the SDQ
    // for 11–17 and for 18+ (D-51) — share wording by design: nobody is given both.
    const ages = new Map(everything.map((i) => [i.instrument, i.ageRange]));
    const disjoint = (a: string, b: string) => {
      const [x, y] = [ages.get(a), ages.get(b)];
      return !!x && !!y && (x.max < y.min || y.max < x.min);
    };
    const seen = new Map<string, { inst: string; at: string }>();
    const dupes: string[] = [];
    for (const { inst, item } of canonicalItems) {
      if (item.responseType === "info") continue;
      const at = `${inst}/${item.key}`;
      const prev = seen.get(item.stem.text);
      if (prev && !disjoint(prev.inst, inst)) dupes.push(`${at} duplicates ${prev.at}`);
      else if (!prev) seen.set(item.stem.text, { inst, at });
    }
    expect(dupes).toEqual([]);
  });

  it("a hard-required item never also offers a decline control", () => {
    // "You must answer" and "you may refuse" cannot both be true. A decline
    // *option* inside a scale ("Prefer not to say") is different and fine:
    // that is an answer, not a refusal to give one.
    const bad = canonicalItems
      .filter(({ item }) => item.required === "hard" && item.allowDecline)
      .map(({ inst, item }) => `${inst}/${item.key}`);
    expect(bad).toEqual([]);
  });
});

describe("date of birth bounds", () => {
  /**
   * Researchers narrow the plausible age range per study. Nothing widens past
   * the absolute ceiling — a mis-set configuration must not be able to admit
   * an implausible date of birth into the data (D-29).
   */
  it("no item may declare an age above the absolute ceiling", () => {
    expect(ABSOLUTE_MAX_AGE_YEARS).toBe(120);
    for (const inst of everything) {
      for (const form of inst.forms) {
        for (const item of form.items) {
          if (item.responseType !== "date") continue;
          if (item.maxAgeYears !== undefined) {
            expect(item.maxAgeYears, `${inst.instrument}/${item.key}`).toBeLessThanOrEqual(ABSOLUTE_MAX_AGE_YEARS);
          }
          if (item.minAgeYears !== undefined && item.maxAgeYears !== undefined) {
            expect(item.minAgeYears, `${inst.instrument}/${item.key}`).toBeLessThan(item.maxAgeYears);
          }
        }
      }
    }
  });

  it("the schema itself refuses a release that tries to exceed it", () => {
    const tooOld = {
      responseType: "date",
      key: "dob",
      revision: 1,
      variable: "dob",
      stem: { text: "Date of birth" },
      maxAgeYears: ABSOLUTE_MAX_AGE_YEARS + 1,
    };
    expect(() => itemDefinition.parse(tooOld)).toThrow();
    expect(() => itemDefinition.parse({ ...tooOld, maxAgeYears: ABSOLUTE_MAX_AGE_YEARS })).not.toThrow();
  });
});

describe("instruments and modules", () => {
  it("11 instruments and 10 modules parse", () => {
    expect(parsedInstruments).toHaveLength(11);
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
    const sdq18 = parsedInstruments.find((i) => i.instrument === "sdq25_s18")!;
    const rcads = parsedInstruments.find((i) => i.instrument === "rcads25")!;
    for (const form of [...sdq.forms, ...sdq18.forms, ...rcads.forms]) {
      for (const item of form.items) {
        expect(item.required).toBe("soft");
        expect(item.allowDecline).toBe(true);
      }
    }
  });

  it("D-51: the SDQ is the 11–17 self-report word for word, and the 18+ its own instrument", () => {
    const sdq = parsedInstruments.find((i) => i.instrument === "sdq25_s")!;
    const [canonical, administered] = [sdq.forms.find((f) => !f.variant)!, sdq.forms.find((f) => f.variant)!];
    const at = (form: typeof canonical, n: number) => form.items.find((i) => i.key === `q${n}`)!;
    expect(sdq.version).toBe("2.0");
    expect(at(canonical, 19).stem.text).toBe("Other children or young people pick on me or bully me");
    expect(at(canonical, 20).stem.text).toBe("I often volunteer to help others (parents, teachers, children)");
    expect(at(canonical, 22).stem.text).toBe("I take things that are not mine from home, school or elsewhere");
    // a changed wording is a new revision, under the same variable; the rest are untouched
    for (const n of [19, 20, 22]) {
      expect(at(canonical, n)).toMatchObject({ revision: 2, variable: `sdq25_q${n}` });
      expect(at(administered, n).revision).toBe(1);
      expect(at(administered, n).stem.text).not.toBe(at(canonical, n).stem.text);
    }
    expect(canonical.items.filter((i) => i.revision !== 1).map((i) => i.key)).toEqual(["q19", "q20", "q22"]);
    // what was fielded before MySelf is kept as it was
    expect(at(administered, 20).stem.text).toBe("I often offer to help others (family members, friends, colleagues)");

    const adult = parsedInstruments.find((i) => i.instrument === "sdq25_s18")!;
    expect(adult.ageRange).toEqual({ min: 18, max: 120 });
    expect(sdq.ageRange).toEqual({ min: 11, max: 17 });
    const items = adult.forms[0]!.items;
    expect(items.map((i) => i.variable)).toEqual(Array.from({ length: 25 }, (_, i) => `sdq25_s18_q${i + 1}`));
    expect(items.every((i) => i.legacyVariable === undefined)).toBe(true); // never fielded in Qualtrics
    expect(items.find((i) => i.key === "q23")!.stem.text).toBe(
      "I get along better with older people than with people of my own age",
    );
    // item 22 is the study's adaptation of the S18+ wording (D-52), and says so
    const q22 = items.find((i) => i.key === "q22")!;
    expect(q22.stem.text).toBe("I take things that are not mine from home, school or college, university, work or elsewhere");
    expect(q22.researcherNote).toContain("home, work or elsewhere");
    // scored the same way: same subscales and reverse-scored items
    expect(adult.subscales).toEqual(sdq.subscales);
    expect(adult.reverseScoredItems).toEqual(sdq.reverseScoredItems);
    expect(adult.scoringKey).toBe("score.sdq25_s18");
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

describe("D-53: shorter consent, sleep quality and sanity checks", () => {
  const moduleItems = (instrument: string) => parsedModules.find((m) => m.instrument === instrument)!.forms[0]!.items;
  const consentItems = moduleItems("ybm_intro_consent");

  it("the consent screen moves on by itself, and says so before it does", () => {
    const consent = consentItems.find((i) => i.key === "consent")!;
    if (consent.responseType !== "checkbox_set") throw new Error("wrong type");
    expect(consent.autoAdvance).toBe(true);
    expect(consent.stem.text).toMatch(/move on once they're all ticked/);
  });

  it("gives the study's address, never a team member's", () => {
    const text = JSON.stringify(everything);
    expect(text).not.toContain("m.faizah@");
    expect(text).toContain("brainpop@leeds.ac.uk");
  });

  it("asks for linkage consent on its own, straight after the consent statements", () => {
    const keys = consentItems.map((i) => i.key);
    expect(keys.indexOf("linkage_consent")).toBe(keys.indexOf("consent") + 1);
    const linkage = consentItems.find((i) => i.key === "linkage_consent")!;
    if (linkage.responseType !== "single_choice") throw new Error("wrong type");
    expect(linkage.scale).toBe("scale.linkage_consent");
    expect(linkage.lede?.text).toMatch(/Connected Yorkshire/);
    expect(linkage.lede?.text).toMatch(/replaced with a code/);
    expect(linkage.lede?.text).toMatch(/brainpop@leeds\.ac\.uk/);
    expect(linkage.identifying).toBe(false);
  });

  it("the why-it-matters screen is answered 'I understand'", () => {
    const why = consentItems.find((i) => i.key === "why_it_matters")!;
    if (why.responseType !== "info") throw new Error("wrong type");
    expect(why.advanceLabel).toBe("I understand");
  });

  it("lists ethnic origins most common in West Yorkshire first, with every code unchanged", () => {
    const eth = parsedScales.find((s) => s.key === "scale.ethnicity_uk20")!;
    expect(eth.version).toBe("2.0.0");
    expect(eth.options.slice(0, 4).map((o) => o.label)).toEqual([
      "English, Welsh, Scottish, Northern Irish or British",
      "Pakistani",
      "Any other White background",
      "Indian",
    ]);
    expect(eth.options.at(-1)).toMatchObject({ code: 20, label: "Prefer not to say", kind: "decline" });
    // The code for each label is the one Qualtrics used, whatever its position.
    const codeOf = Object.fromEntries(eth.options.map((o) => [o.label, o.code]));
    expect(codeOf["Indian"]).toBe(1);
    expect(codeOf["Pakistani"]).toBe(2);
    expect(codeOf["English, Welsh, Scottish, Northern Irish or British"]).toBe(13);
    expect(codeOf["Arab"]).toBe(19);
    expect([...eth.options.map((o) => o.code)].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const o of eth.options) expect(o.legacyCode).toBe(o.code);
    const item = moduleItems("ybm_demographics").find((i) => i.key === "ethnicity")!;
    if (item.responseType !== "single_choice") throw new Error("wrong type");
    expect(item.scaleVersion).toBe("2.0.0");
  });

  it("the SQS is 0-10 with the published bands, shown as one numbered row", () => {
    const sqs = parsedInstruments.find((i) => i.instrument === "sqs")!;
    const q1 = sqs.forms[0]!.items[0]!;
    if (q1.responseType !== "single_choice") throw new Error("wrong type");
    expect(q1.stem.text).toBe("During the past 7 days, how would you rate your sleep quality overall?");
    expect(q1.presentation).toBe("numbered");
    expect(q1.legacyVariable).toBeUndefined();
    const scale = parsedScales.find((s) => s.key === q1.scale)!;
    expect(scale.options.map((o) => o.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scale.bands).toEqual([
      { label: "Terrible", from: 0, to: 0 },
      { label: "Poor", from: 1, to: 3 },
      { label: "Fair", from: 4, to: 6 },
      { label: "Good", from: 7, to: 9 },
      { label: "Excellent", from: 10, to: 10 },
    ]);
    expect(sqs.licence.verified).toBe(false);
  });

  it("checks a long time without social media, and asks how family manage it", () => {
    const items = moduleItems("ybm_social_media");
    const days = items.find((i) => i.key === "abstain_days")!;
    if (days.responseType !== "numeric") throw new Error("wrong type");
    expect(days.confirmAbove).toBe(90);
    expect(days.max).toBe(3650);
    const keys = items.map((i) => i.key);
    expect(keys.slice(keys.indexOf("family_control"))).toEqual(["family_control", "family_control_how", "family_control_other"]);
    const how = items.find((i) => i.key === "family_control_how")!;
    expect(how.displayIf).toMatchObject({ op: "selected", code: 1 });
    const other = items.find((i) => i.key === "family_control_other")!;
    const scale = parsedScales.find((s) => s.key === "scale.sm_family_control_how")!;
    const something = scale.options.find((o) => o.kind === "other_specify")!;
    expect(other.displayIf).toMatchObject({ op: "selected", code: something.code });
  });

  it("asks about English as a first language, other languages, and how well each is understood and spoken", () => {
    const items = moduleItems("ybm_demographics");
    const keys = items.map((i) => i.key);
    expect(keys.slice(keys.indexOf("ethnicity") + 1, keys.indexOf("ethnicity") + 5)).toEqual([
      "first_language_english",
      "speaks_other_language",
      "other_languages",
      "other_language_named",
    ]);
    const languages = parsedScales.find((s) => s.key === "scale.other_languages")!;
    expect(languages.options.slice(0, 3).map((o) => o.label)).toEqual(["Urdu", "Punjabi", "Polish"]);
    expect(languages.options.at(-1)).toMatchObject({ label: "Another language", kind: "other_specify" });
    // Two questions per language (D-58), understanding then speaking, on one
    // scale, shown only when that language is ticked.
    for (const o of languages.options) {
      const asked = items.filter(
        (i) =>
          i.displayIf?.op === "selected" &&
          i.displayIf.target.item.item === "other_languages" &&
          i.displayIf.code === o.code &&
          i.responseType === "single_choice",
      );
      expect(asked.map((i) => i.key.split("_")[0]), o.label).toEqual(["understand", "speak"]);
      for (const i of asked) expect(i.responseType === "single_choice" && i.scale).toBe("scale.language_ability_5");
      if (o.kind !== "other_specify" && o.label !== "British Sign Language") {
        expect(asked[0]!.stem.text).toBe(`How well do you understand ${o.label} when someone speaks it?`);
        expect(asked[1]!.stem.text).toBe(`How well can you speak ${o.label}?`);
      }
    }
    for (const key of ["understand_other_language", "speak_other_language"]) {
      const other = items.find((i) => i.key === key)!;
      expect(other.stem.pipes?.["language"]).toMatchObject({ kind: "item_text_entry", fallback: "the other language you speak" });
    }
    const ability = parsedScales.find((s) => s.key === "scale.language_ability_5")!;
    expect(ability.options.map((o) => o.label)).toEqual(["Very well", "Well", "Not very well", "Only a few words", "Not at all"]);
  });

  it("the address question can find a street for someone who doesn't know their postcode", () => {
    const address = moduleItems("ybm_identity").find((i) => i.key === "home_address")!;
    if (address.responseType !== "form_fields") throw new Error("wrong type");
    expect(address.streetCheck).toEqual({
      field: "street",
      asset: "streets_west_yorkshire",
      areaKey: "area",
      districtKey: "postcode_district",
    });
    expect(address.fields.map((f) => f.key)).toEqual(["postcode", "house", "street"]);
  });
});
