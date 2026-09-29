import { describe, expect, it } from "vitest";
import { allInstruments, allModules, allScales } from "@myself/library";
import { allScoring } from "@myself/scoring";
import { releaseAssets } from "./assets.js";
import { ybmComposition } from "./compose-ybm.js";
import { freezeRelease, requiredEngineVersion, type PublishMeta, type Registries } from "./gate.js";

/**
 * Component `items` subsets (D-49) through the publish gate.
 *
 * A subset is what lets a question move to another section without changing
 * its ID, so the gate has to treat the ADMINISTERED order — subsets included —
 * as the order that matters. Everything here is about that: the dependency audit
 * follows it, a subset cannot name a question the form lacks or ask one twice,
 * and a release that uses subsets must declare the engine that renders them.
 *
 * (That rebuilding r7.1.0 still produces its committed hash is covered by
 * release.test.ts.)
 */

const registries: Registries = {
  instruments: allInstruments,
  modules: allModules,
  scales: allScales,
  scoring: allScoring,
  assets: releaseAssets(),
};

const meta = (engineVersion: string): PublishMeta => ({
  version: "8.0.0",
  publishedAt: "2026-09-28T12:00:00.000Z",
  publishedBy: "gate-test",
  engineVersion,
});

type Composition = typeof ybmComposition;
type Placement = Extract<Composition["sections"][number]["components"][number], { kind: "module" }>;

/** The YBM composition with one change, frozen as the Studio would freeze it. */
function freeze(change: (c: Composition) => void, regs: Registries = registries, engine?: string) {
  const composition = structuredClone(ybmComposition);
  change(composition);
  return freezeRelease(composition, regs, meta(engine ?? requiredEngineVersion(composition)));
}

function section(c: Composition, key: string) {
  const found = c.sections.find((s) => s.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
}

/** The smartphone module's placement: own → age_smartphone (if own) → sm_use → sm_use_confirm → age_sm. */
function smartphone(c: Composition): Placement {
  const component = section(c, "phones").components.find(
    (x): x is Placement => x.kind === "module" && x.ref.instrument === "ybm_smartphone",
  );
  if (!component) throw new Error("no smartphone placement");
  return component;
}

const SMARTPHONE = ["own", "age_smartphone", "sm_use", "sm_use_confirm", "age_sm"];

describe("subsets in the dependency audit", () => {
  it("follow the subset's order, not the form's", () => {
    // age_smartphone's condition is on `own`, which comes first in the form.
    // Placed after it by the subset, the condition can never be met.
    const { failures } = freeze((c) => {
      smartphone(c).items = ["age_smartphone", "own", "sm_use", "sm_use_confirm", "age_sm"];
    });
    expect(failures).toEqual([expect.stringMatching(/^ybm_smartphone\.age_smartphone: display condition depends on 'ybm_smartphone\.own', which is asked later/)]);
  });

  it("so a subset can also put right an order the form gets wrong", () => {
    const regs = structuredClone(registries);
    const form = regs.modules.find((m) => m.instrument === "ybm_smartphone")!.forms[0]!;
    form.items.push(form.items.shift()!); // `own` now last in the form
    expect(freeze(() => {}, regs).failures).toEqual([expect.stringMatching(/age_smartphone: .* depends on 'ybm_smartphone\.own', which is asked later/)]);
    expect(freeze((c) => (smartphone(c).items = SMARTPHONE), regs).failures).toEqual([]);
  });

  it("bind a section condition at the first question the section actually shows", () => {
    // The social-media section is shown on sm_use / sm_use_confirm. Moving
    // sm_use_confirm into that section puts it after the point the condition
    // is evaluated.
    const { failures } = freeze((c) => {
      smartphone(c).items = ["own", "age_smartphone", "sm_use", "age_sm"];
      section(c, "social_media").components.unshift({ ...structuredClone(smartphone(c)), items: ["sm_use_confirm"] });
    });
    expect(failures).toContainEqual(expect.stringMatching(/section 'social_media' condition depends on 'ybm_smartphone\.sm_use_confirm', which is asked later/));
  });
});

describe("subset membership", () => {
  it("refuses a key the form does not have", () => {
    const { failures } = freeze((c) => {
      smartphone(c).items = [...SMARTPHONE, "owns_tablet"];
    });
    expect(failures).toEqual(["section 'phones' places 'ybm_smartphone.owns_tablet', which is not a question of 'ybm_smartphone'"]);
  });

  it("refuses a question listed twice in one placement", () => {
    const { failures } = freeze((c) => {
      smartphone(c).items = [...SMARTPHONE, "own"];
    });
    expect(failures).toEqual(["section 'phones' lists 'ybm_smartphone.own' twice in one placement"]);
  });

  it("refuses a question placed in two sections", () => {
    const { failures } = freeze((c) => {
      section(c, "gaming").components.push({ ...structuredClone(smartphone(c)), items: ["own"] });
    });
    expect(failures).toContainEqual("'ybm_smartphone.own' is administered more than once (sections 'phones' and 'gaming')");
  });

  it("refuses the whole form placed twice", () => {
    const { failures } = freeze((c) => {
      section(c, "gaming").components.push(structuredClone(smartphone(c)));
    });
    expect(failures.filter((f) => f.includes("administered more than once"))).toHaveLength(SMARTPHONE.length);
  });

  it("accepts a module split across two sections, each question once", () => {
    const { failures, body } = freeze((c) => {
      smartphone(c).items = ["own", "age_smartphone", "sm_use", "sm_use_confirm"];
      section(c, "social_media").components.unshift({ ...structuredClone(smartphone(c)), items: ["age_sm"] });
    });
    expect(failures).toEqual([]);
    expect(body.release.engineVersion).toBe("0.2.0");
  });
});

describe("engine version", () => {
  it("is 0.2.0 when a placement uses a subset, a condition judges age, or a question checks postcodes", () => {
    const plain = { sections: [{ components: [{ kind: "module" }, { kind: "instrument" }] }] };
    expect(requiredEngineVersion(plain)).toBe("0.1.0");
    expect(requiredEngineVersion({ sections: [{ components: [{ kind: "module", items: ["a"] }] }] })).toBe("0.2.0");
    // Screens and narratives have no questions to subset.
    expect(requiredEngineVersion({ sections: [{ components: [{ kind: "screen", items: ["x"] }] }] })).toBe("0.1.0");
    // Age (D-51): in a block condition, or inside a question's own.
    const age = { op: "age_gte", target: { item: { instrument: "ybm_identity", item: "dob", revision: 1 } }, years: 18 };
    expect(requiredEngineVersion({ sections: [{ components: [{ kind: "module", displayIf: age }] }] } as unknown as typeof plain)).toBe("0.2.0");
    expect(requiredEngineVersion(plain, { instruments: [{ forms: [{ items: [{ displayIf: age }] }] }] })).toBe("0.2.0");
    // Postcodes (D-52): a pinned list, or a question that checks against one.
    expect(requiredEngineVersion(plain, { assets: { postcodes_west_yorkshire: {} } })).toBe("0.2.0");
    expect(requiredEngineVersion(plain, { instruments: [{ forms: [{ items: [{ postcodeCheck: {} }] }] }] })).toBe("0.2.0");
    // The live composition uses both.
    expect(requiredEngineVersion(ybmComposition)).toBe("0.2.0");
  });

  it("refuses a subset-using release that declares the older engine", () => {
    const subset = (c: Composition) => {
      smartphone(c).items = SMARTPHONE;
    };
    expect(freeze(subset, registries, "0.1.0").failures).toEqual([
      "this composition needs engine 0.2.0, but the release declares engine 0.1.0",
    ]);
    expect(freeze(subset, registries, "0.2.0").failures).toEqual([]);
  });
});
