import { describe, expect, it } from "vitest";
import { logicExpr } from "./logic.js";
import { instrumentVersion } from "./instrument.js";
import { responseScale } from "./response-scale.js";
import { narrativeProtocol } from "./narrative.js";
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

  it("rejects an unknown operator", () => {
    expect(() => logicExpr.parse({ op: "regex", target: { item: smOwn }, value: ".*" })).toThrow();
  });
});

describe("narrative protocol", () => {
  it("requires fallbackText only when declared behaviour needs it (schema-level shape check)", () => {
    const minimal = {
      key: "np.micro_narrative",
      version: "1.0.0",
      name: "Micro-narrative (generalised CHI 2025 protocol)",
      construct: "Lived-experience narrative",
      intendedUse: "Guided story elicitation",
      ageRange: { min: 11, max: 18 },
      language: "en-GB",
      readingLevel: "standard",
      introduction: "We'd like to hear your story.",
      questions: ["What happened?", "How did it make you feel?"],
      responseModes: ["text"],
      interviewerPersona: "A supportive school counsellor collecting stories.",
      languageStyle: "Empathetic, youth-friendly, descriptive.",
      topicRestriction: "Stay on the study topic; never answer for the participant.",
      extractionKeys: { what: "What happened?", feeling: "How did they feel?" },
      scenarioPersonas: [{ key: "formal", description: "A formal developmental psychologist." }],
      prompts: [{ role: "interviewer", key: "pt.micro_narrative.interviewer", version: "1.0.0" }],
      systemInstructions: "You are part of a research protocol. Do not diagnose or advise.",
      modelConfigKey: "mc.openai.gpt4o.t03",
      outputSchemas: { scenario: { type: "object" } },
      safeguarding: [],
      connectivity: "offline_capable_with_queue",
      offlineBehaviour: "queue_authorised",
      estimatedSeconds: 480,
      consentRequirements: "Study consent covering LLM processing.",
      dataGovernanceNote: "No direct identifiers reach the provider.",
      owner: "ybm",
      changelog: "1.0.0: initial",
    };
    expect(narrativeProtocol.parse(minimal).selectionRequired).toBe(true);
  });
});
