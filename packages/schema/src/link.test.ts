import { describe, expect, it } from "vitest";
import {
  choiceKey,
  participantLink,
  readParticipantLink,
  readTypedChoice,
  sameChoice,
  slug,
  STUDY_ID_PATTERN,
  studyId,
} from "./index.js";

/**
 * The participant link (D-56, docs/16 §11.2): the one format the Studio writes,
 * the survey reads and the functions check. Every refusal here is a link that
 * would otherwise have put an id somewhere it could name another document.
 */

const BASE = "https://faisalmushtaq.github.io/MySelf/";

describe("reading a participant link", () => {
  it("reads both ids", () => {
    expect(readParticipantLink("?study=future&survey=future_main", "ybm")).toEqual({
      kind: "choice",
      choice: { study: "future", surveyId: "future_main" },
    });
  });

  it("gives no instruction for the bare address, so every iPad today stays as it is", () => {
    expect(readParticipantLink("", "ybm")).toEqual({ kind: "none" });
    expect(readParticipantLink("?utm_source=poster", "ybm")).toEqual({ kind: "none" });
  });

  it("takes a survey alone as the default study's", () => {
    expect(readParticipantLink("?survey=ybm_stage2", "ybm")).toEqual({
      kind: "choice",
      choice: { study: "ybm", surveyId: "ybm_stage2" },
    });
  });

  it("refuses a study with no survey, and either parameter twice", () => {
    expect(readParticipantLink("?study=future", "ybm").kind).toBe("invalid");
    expect(readParticipantLink("?study=a1&study=b2&survey=s", "ybm").kind).toBe("invalid");
    expect(readParticipantLink("?study=ab&survey=s&survey=t", "ybm").kind).toBe("invalid");
  });

  it.each([
    ["upper case", "?study=Future&survey=s"],
    ["a slash, plain", "?study=ybm/x&survey=s"],
    ["a slash, encoded", "?study=ybm%2Fsessions&survey=s"],
    ["a dot-dot", "?study=..&survey=s"],
    ["a leading digit", "?study=1ybm&survey=s"],
    ["one character", "?study=y&survey=s"],
    ["41 characters", `?study=${"a".repeat(41)}&survey=s`],
    ["a space (plus)", "?study=ybm+x&survey=s"],
    ["a reserved name", "?study=__name__&survey=s"],
    ["an empty survey", "?study=ybm&survey="],
    ["a survey with a hash", "?study=ybm&survey=s%23x"],
    ["a 65-character survey", `?study=ybm&survey=${"s".repeat(65)}`],
  ])("refuses %s, saying why", (_label, search) => {
    const reading = readParticipantLink(search, "ybm");
    expect(reading.kind).toBe("invalid");
    expect(reading.kind === "invalid" ? reading.problem : "").not.toBe("");
  });

  it("keeps a refused value short in the message", () => {
    const reading = readParticipantLink(`?study=${"x".repeat(500)}&survey=s`, "ybm");
    expect(reading.kind === "invalid" ? reading.problem.length : 0).toBeLessThan(80);
  });
});

describe("what staff type into the handover panel", () => {
  it("accepts a whole link, study/survey, or a survey alone", () => {
    expect(readTypedChoice(`${BASE}?study=future&survey=f1`, "ybm")).toEqual({
      kind: "choice",
      choice: { study: "future", surveyId: "f1" },
    });
    expect(readTypedChoice(" future/f1 ", "ybm")).toEqual({ kind: "choice", choice: { study: "future", surveyId: "f1" } });
    expect(readTypedChoice("ybm_stage2", "ybm")).toEqual({ kind: "choice", choice: { study: "ybm", surveyId: "ybm_stage2" } });
  });

  it("refuses anything a link could not say", () => {
    expect(readTypedChoice(BASE, "ybm").kind).toBe("invalid");
    expect(readTypedChoice("a/b/c", "ybm").kind).toBe("invalid");
    expect(readTypedChoice("Future/f1", "ybm").kind).toBe("invalid");
    expect(readTypedChoice("https://", "ybm").kind).toBe("invalid");
    expect(readTypedChoice("", "ybm")).toEqual({ kind: "none" });
  });
});

describe("writing a participant link", () => {
  it("always names both, so a link to the default survey can move an iPad back", () => {
    expect(participantLink(BASE, { study: "ybm", surveyId: "ybm_nd2026_standard" })).toBe(
      `${BASE}?study=ybm&survey=ybm_nd2026_standard`,
    );
  });

  it("drops whatever the base address carried", () => {
    expect(participantLink(`${BASE}?x=1#/surveys`, { study: "future", surveyId: "f1" })).toBe(`${BASE}?study=future&survey=f1`);
  });

  it("reads back as what it was written from", () => {
    const choice = { study: "future", surveyId: "future_main" };
    const reading = readParticipantLink(new URL(participantLink(BASE, choice)).search, "ybm");
    expect(reading.kind === "choice" && sameChoice(reading.choice, choice)).toBe(true);
  });

  it("refuses to write a link with an id off its pattern", () => {
    expect(() => participantLink(BASE, { study: "Bad", surveyId: "s" })).toThrow();
    expect(() => participantLink(BASE, { study: "ok", surveyId: "s/x" })).toThrow();
  });
});

describe("a study id", () => {
  it("is always a slug, with room for the Studio's own module key", () => {
    for (const id of ["ab", "ybm", "future_2026", "a".repeat(40)]) {
      expect(studyId.safeParse(id).success).toBe(true);
      expect(slug.safeParse(`${id}_studio`).success).toBe(true);
    }
    expect(STUDY_ID_PATTERN.test("ybm")).toBe(true);
  });

  it("writes a choice as study/survey", () => {
    expect(choiceKey({ study: "ybm", surveyId: "s" })).toBe("ybm/s");
  });
});
