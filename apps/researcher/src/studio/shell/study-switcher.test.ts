import { describe, expect, it } from "vitest";
import { STUDY_ID_PATTERN } from "@myself/schema";
import { participantBase } from "../screens/ParticipantLink.js";
import { studyIdProblem, suggestStudyId } from "./StudySwitcher.js";

/**
 * The Studio's side of study spaces (D-56): the id a new study space is
 * offered, why one is refused before anything is sent, and where a survey's
 * participant link points.
 */

describe("a new study space's id", () => {
  it("is suggested from the title as an id a link can carry", () => {
    expect(suggestStudyId("Perspectives of the Future")).toBe("perspectives_of_the_future");
    expect(suggestStudyId("2027: Stage 2 — MyPhone MyBrain!")).toBe("stage_2_myphone_mybrain");
    const long = suggestStudyId("A very long title that goes on well past forty characters in all");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(STUDY_ID_PATTERN.test(long)).toBe(true);
  });

  it("is refused, in words, when it could not be a study id or is taken", () => {
    expect(studyIdProblem("", [])).toMatch(/Give/);
    expect(studyIdProblem("f", [])).toMatch(/at least 2/);
    expect(studyIdProblem("a".repeat(41), [])).toMatch(/at most 40/);
    expect(studyIdProblem("Future", [])).toMatch(/lower-case/);
    expect(studyIdProblem("future", ["ybm", "future"])).toMatch(/already/);
    expect(studyIdProblem("future", ["ybm"])).toBeNull();
  });
});

describe("where a participant link points", () => {
  it("is the survey's address: the folder above the researcher view's", () => {
    expect(participantBase({ origin: "https://faisalmushtaq.github.io", pathname: "/MySelf/researcher/" })).toBe(
      "https://faisalmushtaq.github.io/MySelf/",
    );
    expect(participantBase({ origin: "http://localhost:4175", pathname: "/MySelf/researcher/index.html" })).toBe(
      "http://localhost:4175/MySelf/",
    );
  });
});
