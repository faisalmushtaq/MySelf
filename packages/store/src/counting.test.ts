import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import { assessSitting, indexReleaseQuestions, replaySitting, validateAnswer } from "./completeness.js";
import { countSittings, DEFAULT_COUNTING_RULES, isTestCode, judgeSitting, lifecycleOf, type LifecycleFacts } from "./counting.js";
import { buildDemoSessions } from "./demo.js";
import { ingest, type DeviceSession } from "./ingest.js";

/**
 * The counting rules the researcher view and the research dashboard share.
 *
 * The dashboard vendors counting.ts and completeness.ts and has its own, larger test
 * that feeds one study down both tools and requires every shared figure to match. These
 * are the rules one at a time, where a failure names the rule that broke.
 */

const manifest: ReleaseManifest = releaseManifest.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json", import.meta.url)), "utf8"),
  ),
);
const manifests = new Map([[manifest.hash!, manifest]]);
const index = indexReleaseQuestions(manifest);
const now = new Date("2026-09-30T08:00:00.000Z");

const facts = (over: Partial<LifecycleFacts>): LifecycleFacts => ({
  terminal: false,
  hasResponses: true,
  releaseKnown: true,
  requiredMissing: 0,
  ...over,
});

describe("test sittings", () => {
  it("are the codes the dashboard calls test by default, in either case", () => {
    const { testCodePatterns } = DEFAULT_COUNTING_RULES;
    expect(testCodePatterns).toEqual(["^TST", "^ZZZ"]);
    expect(isTestCode("TST0012", testCodePatterns)).toBe(true);
    expect(isTestCode("zzz01", testCodePatterns)).toBe(true);
    expect(isTestCode("NTH1001", testCodePatterns)).toBe(false);
    expect(isTestCode(undefined, testCodePatterns)).toBe(false);
  });

  it("do not include the researcher view's demonstration sites", () => {
    // Demonstration data is marked by its DEMO site, not by being test data: it is
    // counted like any other so the view can be shown working.
    expect(isTestCode("DEMOA01", DEFAULT_COUNTING_RULES.testCodePatterns)).toBe(false);
  });

  it("treat a pattern that is not an expression as matching nothing", () => {
    expect(isTestCode("TST1", ["(", "^TST"])).toBe(true);
    expect(isTestCode("TST1", ["("])).toBe(false);
  });
});

describe("where a sitting stands", () => {
  it("reached the end with a required answer missing is incomplete, otherwise complete", () => {
    expect(lifecycleOf(facts({ terminal: true, requiredMissing: 2 }), 24, now)).toBe("incomplete");
    expect(lifecycleOf(facts({ terminal: true }), 24, now)).toBe("complete");
  });

  it("cannot be judged incomplete when its release is unknown", () => {
    expect(lifecycleOf(facts({ terminal: true, releaseKnown: false, requiredMissing: 3 }), 24, now)).toBe("complete");
  });

  it("has not started until a question has any response", () => {
    expect(lifecycleOf(facts({ hasResponses: false, receivedAt: now.toISOString() }), 24, now)).toBe("not_started");
  });

  it("is abandoned once the study has not heard from it for the window, by the server's clock first", () => {
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    expect(lifecycleOf(facts({ receivedAt: hoursAgo(2) }), 24, now)).toBe("in_progress");
    expect(lifecycleOf(facts({ receivedAt: hoursAgo(30) }), 24, now)).toBe("abandoned");
    // A device clock saying "just now" does not rescue a sitting the server last heard of long ago.
    expect(lifecycleOf(facts({ receivedAt: hoursAgo(30), lastActivityAt: hoursAgo(1) }), 24, now)).toBe("abandoned");
    // With no server time (a sitting only ever seen in a file), the log's own clock is all there is.
    expect(lifecycleOf(facts({ lastActivityAt: hoursAgo(1) }), 24, now)).toBe("in_progress");
    expect(lifecycleOf(facts({}), 24, now)).toBe("abandoned");
  });
});

describe("the release's questions", () => {
  it("leaves out information screens, instructions and narratives", () => {
    expect(index.questions.every((q) => q.responseType !== "info")).toBe(true);
    expect(index.questions.some((q) => q.key.includes(".__"))).toBe(false);
    expect([...index.unitKeys].some((k) => k.includes(".__instructions_"))).toBe(true);
  });

  it("numbers questions in the order a participant meets them", () => {
    expect(index.questions.map((q) => q.order)).toEqual(index.questions.map((_, i) => i));
    expect(index.questions[0]!.key).toBe("ybm_intro_consent.consent");
  });

  it("judges an answer against the release's own definition", () => {
    const ladder = index.questions.find((q) => q.responseType === "ladder")!;
    expect(validateAnswer(ladder, { kind: "number", value: 4 }).valid).toBe(true);
    expect(validateAnswer(ladder, { kind: "choice", code: 4 }).valid).toBe(false);
    expect(validateAnswer(ladder, null).reason).toMatch(/corrupted/);
  });
});

/** The demonstration study, with one sitting that gave no name or date of birth and one test sitting. */
function study(): DeviceSession[] {
  const sessions = buildDemoSessions({ manifest, participants: 12 });
  const anonymous: DeviceSession = {
    ...sessions[0]!,
    sessionId: "ses_no_name",
    events: sessions[0]!.events.filter((e) => !e.itemKey?.startsWith("ybm_identity.")),
  };
  const test: DeviceSession = { ...sessions[1]!, sessionId: "ses_test", studyCode: "TST0001" };
  // A test sitting gets its own person, so it cannot join anybody's waves.
  test.events = test.events.map((e) =>
    e.itemKey === "ybm_identity.first_name" ? { ...e, payload: { value: { kind: "text", value: "Tess" } } } : e,
  );
  return [...sessions, anonymous, test];
}

describe("counting a study", () => {
  const sittings = study();
  const dataset = ingest(sittings, { manifest, study: "ybm" }).dataset;
  const counted = countSittings({ sittings, dataset, manifests, now });
  const withTest = countSittings({ sittings, dataset, manifests, now, includeTest: true });

  it("counts a sitting nobody can be linked to as a sitting, and says so", () => {
    expect(dataset.sessions.some((s) => s.sessionId === "ses_no_name")).toBe(false);
    expect(counted.figures.sittings).toBe(sittings.length - 1);
    expect(counted.figures.notLinked).toBe(1);
    expect(counted.figures.linked).toBe(counted.figures.sittings - 1);
    expect(counted.lifecycles.has("ses_no_name")).toBe(true);
  });

  it("leaves test sittings out unless asked, and says how many there were", () => {
    expect(counted.test).toEqual({ count: 1, included: false });
    expect(counted.lifecycles.has("ses_test")).toBe(false);
    expect(counted.dataset.sessions.some((s) => s.sessionId === "ses_test")).toBe(false);
    expect(withTest.figures.sittings).toBe(counted.figures.sittings + 1);
    expect(withTest.figures.participants).toBe(counted.figures.participants + 1);
  });

  it("puts both completion measures over the sittings that have finished or been abandoned", () => {
    const f = counted.figures;
    expect(f.finishedOrAbandoned).toBe(f.byLifecycle.complete + f.byLifecycle.incomplete + f.byLifecycle.abandoned);
    expect(f.reachedEnd).toBe(f.byLifecycle.complete + f.byLifecycle.incomplete);
    expect(f.allRequiredAnswered).toBe(f.byLifecycle.complete);
    expect(f.sittings).toBe(Object.values(f.byLifecycle).reduce((a, b) => a + b, 0));
  });

  it("judges every sitting exactly as the assessment does", () => {
    for (const s of sittings.filter((x) => x.sessionId !== "ses_test")) {
      const judged = judgeSitting(s, index, DEFAULT_COUNTING_RULES, now);
      const direct = assessSitting(replaySitting(s), index, { requiredLevels: ["hard", "soft"], sittingStart: s.startedAt });
      expect(judged.assessment.counts).toEqual(direct.counts);
      expect(counted.lifecycles.get(s.sessionId)).toBe(judged.lifecycle);
      if (judged.lifecycle === "complete") expect(direct.counts.requiredMissing).toBe(0);
    }
  });

  it("finds a sitting that skipped a required question incomplete, though it reached the end", () => {
    const skipped = sittings.find(
      (s) => s.complete && s.events.some((e) => e.type === "item.skipped" && index.byKey.get(e.itemKey ?? "")?.required !== "optional"),
    )!;
    expect(judgeSitting(skipped, index, DEFAULT_COUNTING_RULES, now).lifecycle).toBe("incomplete");
  });

  it("reads a sitting whose release it does not know as unjudgeable, not as another release", () => {
    const stranger = { ...sittings[0]!, sessionId: "ses_stranger", releaseHash: "sha256:unknown" };
    const result = countSittings({ sittings: [stranger], dataset, manifests, now });
    expect(result.figures.sittings).toBe(1);
    expect(result.lifecycles.get("ses_stranger")).toBe(stranger.complete ? "complete" : "abandoned");
  });
});

describe("a hidden question's answer (completeness@2)", () => {
  it("does not open the branch below it: changing 'other languages' to No hides the Polish follow-ups too", () => {
    const at = (i: number) => new Date(Date.parse("2026-10-17T09:00:00.000Z") + i * 1000).toISOString();
    const answer = (seq: number, itemKey: string, value: unknown) => ({ seq, type: "response.recorded", itemKey, payload: { value }, tWall: at(seq), tMono: seq * 1000 });
    const sitting = {
      sessionId: "ses_cascade",
      studyCode: "ABC1234",
      releaseKey: manifest.release.key,
      releaseHash: manifest.hash!,
      startedAt: at(0),
      completedAt: at(9),
      complete: true,
      events: [
        { seq: 0, type: "session.started", tWall: at(0), tMono: 0 },
        answer(1, "ybm_demographics.speaks_other_language", { kind: "choice", code: 1 }),
        answer(2, "ybm_demographics.other_languages", { kind: "multi", codes: [3] }),
        answer(3, "ybm_demographics.understand_polish", { kind: "choice", code: 2 }),
        // Back, and changed to No: the languages list is hidden, and so is everything it opened.
        answer(4, "ybm_demographics.speaks_other_language", { kind: "choice", code: 2 }),
        { seq: 9, type: "session.completed", payload: { totalMs: 9000 }, tWall: at(9), tMono: 9000 },
      ],
    } as unknown as DeviceSession;
    const assessed = assessSitting(replaySitting(sitting), index, { requiredLevels: ["hard", "soft"], sittingStart: sitting.startedAt });
    const outcome = (key: string) => assessed.outcomes.find((o) => o.key === key)?.outcome;
    expect(outcome("ybm_demographics.other_languages")).toBe("answered_hidden");
    expect(outcome("ybm_demographics.understand_polish")).toBe("answered_hidden");
    expect(assessed.rulesVersion).toBe("completeness@2");
  });
});
