import { describe, expect, it } from "vitest";
import { DEFAULT_STUDY, formatRoute, isStudioHash, parseHash, safeNext, samePage, studyOfHash, type Route } from "./route.js";

describe("Studio addresses", () => {
  it("reads every page", () => {
    expect(parseHash("#/")).toEqual({ name: "surveys" });
    expect(parseHash("#/surveys")).toEqual({ name: "surveys" });
    expect(parseHash("#/surveys/")).toEqual({ name: "surveys" });
    expect(parseHash("#/login")).toEqual({ name: "login", next: null });
    expect(parseHash("#/access")).toEqual({ name: "access" });
    expect(parseHash("#/playground")).toEqual({ name: "playground", tab: "edit", q: null });
    expect(parseHash("#/playground/preview?q=kss.q1")).toEqual({ name: "playground", tab: "preview", q: "kss.q1" });
    expect(parseHash("#/surveys/ybm_nd2026_standard/edit")).toEqual({
      name: "survey",
      surveyId: "ybm_nd2026_standard",
      tab: "edit",
      q: null,
    });
    for (const tab of ["preview", "versions", "settings"] as const) {
      expect(parseHash(`#/surveys/s1/${tab}`)).toMatchObject({ name: "survey", surveyId: "s1", tab });
    }
  });

  it("opens the editor for a bare survey address", () => {
    expect(parseHash("#/surveys/s1")).toEqual({ name: "survey", surveyId: "s1", tab: "edit", q: null });
  });

  it("reads the selected question on the pages that have one", () => {
    expect(parseHash("#/surveys/s1/edit?q=sdq25_s.q3")).toMatchObject({ q: "sdq25_s.q3" });
    expect(parseHash("#/surveys/s1/preview?q=sdq25_s.q3")).toMatchObject({ q: "sdq25_s.q3" });
    expect(parseHash("#/surveys/s1/versions?q=sdq25_s.q3")).toMatchObject({ q: null });
    expect(parseHash("#/surveys/s1/edit?q=")).toMatchObject({ q: null });
  });

  it("refuses survey IDs that could not be composition keys", () => {
    expect(parseHash("#/surveys/Bad-Id/edit").name).toBe("not_found");
    expect(parseHash("#/surveys/1abc/edit").name).toBe("not_found");
    expect(parseHash("#/surveys/%E0%A4%A/edit").name).toBe("not_found");
    expect(parseHash("#/surveys/s1/publish").name).toBe("not_found");
    expect(parseHash("#/surveys/s1/edit/extra").name).toBe("not_found");
    expect(parseHash("#/elsewhere").name).toBe("not_found");
  });

  it("writes back exactly what it reads", () => {
    const routes: Route[] = [
      { name: "surveys" },
      { name: "access" },
      { name: "login", next: "#/surveys/s1/versions" },
      { name: "survey", surveyId: "s1", tab: "edit", q: "ybm_studio.q_1" },
      { name: "survey", surveyId: "s1", tab: "settings", q: null },
      { name: "playground", tab: "preview", q: "kss.q1" },
      { name: "playground", tab: "edit", q: null },
    ];
    for (const r of routes) expect(parseHash(formatRoute(r))).toEqual(r);
  });

  it("only sends someone back into the Studio after signing in", () => {
    expect(safeNext("#/surveys/s1/versions")).toBe("#/surveys/s1/versions");
    expect(safeNext("#/login?next=%23%2Fsurveys")).toBeNull();
    expect(safeNext("https://example.org/#/surveys")).toBeNull();
    expect(safeNext("#/nowhere")).toBeNull();
    expect(safeNext(null)).toBeNull();
    expect(parseHash("#/login?next=https%3A%2F%2Fevil.example")).toEqual({ name: "login", next: null });
  });

  it("knows which hashes are the Studio’s", () => {
    expect(isStudioHash("#/surveys")).toBe(true);
    expect(isStudioHash("")).toBe(false);
    expect(isStudioHash("#studio-main")).toBe(false);
  });

  it("treats a change of selected question as the same page", () => {
    expect(
      samePage(
        { name: "survey", surveyId: "s", tab: "edit", q: "a.b" },
        { name: "survey", surveyId: "s", tab: "edit", q: null },
      ),
    ).toBe(true);
    expect(
      samePage(
        { name: "survey", surveyId: "s", tab: "edit", q: null },
        { name: "survey", surveyId: "s", tab: "preview", q: null },
      ),
    ).toBe(false);
  });
});

describe("addresses in a study space (D-56)", () => {
  it("leaves every address of the default study as it was", () => {
    expect(studyOfHash("#/surveys/s1/edit")).toBe(DEFAULT_STUDY);
    expect(formatRoute({ name: "surveys" }, DEFAULT_STUDY)).toBe("#/surveys");
    expect(formatRoute({ name: "survey", surveyId: "s1", tab: "versions", q: null })).toBe("#/surveys/s1/versions");
  });

  it("puts another study's pages under its own prefix, and reads them back", () => {
    const routes: Route[] = [
      { name: "surveys" },
      { name: "access" },
      { name: "survey", surveyId: "future_main", tab: "edit", q: "future_studio.q_1" },
      { name: "survey", surveyId: "future_main", tab: "settings", q: null },
    ];
    for (const r of routes) {
      const hash = formatRoute(r, "future");
      expect(hash.startsWith("#/study/future/")).toBe(true);
      expect(studyOfHash(hash)).toBe("future");
      expect(parseHash(hash)).toEqual(r);
    }
    expect(parseHash("#/study/future")).toEqual({ name: "surveys" });
  });

  it("is no page at all when the prefix names something that is not a study id", () => {
    for (const hash of ["#/study/Future/surveys", "#/study//surveys", "#/study/..%2F/surveys", "#/study/a/surveys", "#/study/%E0%A4%A/surveys"]) {
      expect(studyOfHash(hash)).toBeNull();
      expect(parseHash(hash).name).toBe("not_found");
    }
  });

  it("sends someone back to the study they were in after signing in", () => {
    expect(safeNext("#/study/future/surveys/f1/versions")).toBe("#/study/future/surveys/f1/versions");
    expect(safeNext("#/study/Bad/surveys")).toBeNull();
  });
});
