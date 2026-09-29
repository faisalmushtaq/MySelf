import { describe, expect, it } from "vitest";
import { logicExpr } from "./logic.js";
import { instrumentVersion } from "./instrument.js";
import { responseScale } from "./response-scale.js";
import { kssInstrument, kssScaleAsAdministered, kssScaleCanonical } from "./fixtures/kss.js";

describe("response scales", () => {
  it("accepts the canonical and as-administered KSS scales", () => {
    expect(responseScale.parse(kssScaleCanonical).options).toHaveLength(9);
    const asAdmin = responseScale.parse(kssScaleAsAdministered);
    expect(asAdmin.options.find((o) => o.code === 7)?.label).toContain("not no effort");
  });

  it("preserves legacy codes for the crosswalk", () => {
    const parsed = responseScale.parse(kssScaleCanonical);
    for (const o of parsed.options) expect(o.legacyCode).toBe(o.code);
  });

  it("rejects a scale with fewer than two options", () => {
    expect(() =>
      responseScale.parse({ ...kssScaleCanonical, options: kssScaleCanonical.options.slice(0, 1) }),
    ).toThrow();
  });
});

describe("instruments", () => {
  it("accepts the KSS instrument with canonical + ybm-asadmin forms", () => {
    const parsed = instrumentVersion.parse(kssInstrument);
    expect(parsed.forms).toHaveLength(2);
    expect(parsed.forms[1]?.variant).toBe("ybm-asadmin");
  });

  it("rejects an instrument with no time estimates", () => {
    expect(() => instrumentVersion.parse({ ...kssInstrument, timeEstimates: [] })).toThrow();
  });

  it("rejects an unsafe variable name", () => {
    const bad = structuredClone(kssInstrument);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad.forms[0]!.items[0] as any).variable = "TimeSpent on each ";
    expect(() => instrumentVersion.parse(bad)).toThrow();
  });
});

describe("logic AST", () => {
  const smOwn = { instrument: "ybm_smartphone", item: "sm_use", revision: 1 };

  it("accepts the YBM social-media branch condition", () => {
    expect(logicExpr.parse({ op: "selected", target: { item: smOwn }, code: 1 })).toBeTruthy();
  });

  it("accepts the corrected gaming logic (D-03: NOT 'I do not play')", () => {
    const expr = {
      op: "not_selected",
      target: { item: { instrument: "ybm_gaming", item: "gaming_hours_week", revision: 1 } },
      code: 1,
    };
    expect(logicExpr.parse(expr)).toBeTruthy();
  });

  it("accepts nested any/all with in_group (TimeSpent rows, D-02)", () => {
    const expr = {
      op: "all",
      args: [
        {
          op: "in_group",
          target: { item: { instrument: "ybm_social_media", item: "sm_apps_owned", revision: 1 } },
          group: "have",
          code: 9, // Twitch row now correctly tests Twitch (canonical code)
        },
      ],
    };
    expect(logicExpr.parse(expr)).toBeTruthy();
  });

  it("accepts an age condition on the date of birth, in whole years (D-51)", () => {
    const dob = { instrument: "ybm_identity", item: "dob", revision: 1 };
    expect(logicExpr.parse({ op: "not", arg: { op: "age_gte", target: { item: dob }, years: 18 } })).toBeTruthy();
    expect(() => logicExpr.parse({ op: "age_gte", target: { item: dob }, years: 17.5 })).toThrow();
    expect(() => logicExpr.parse({ op: "age_gte", target: { item: dob }, years: -1 })).toThrow();
    expect(() => logicExpr.parse({ op: "age_gte", target: { item: dob } })).toThrow();
  });

  it("rejects an unknown operator", () => {
    expect(() => logicExpr.parse({ op: "regex", target: { item: smOwn }, value: ".*" })).toThrow();
  });
});
