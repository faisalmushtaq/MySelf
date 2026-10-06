import { STUDY_ID_PATTERN } from "@myself/schema";

/**
 * The Studio's addresses.
 *
 * A HASH ROUTER because the Studio is served from GitHub Pages under the
 * researcher view's path, where there is no server to answer a deep link: the
 * path stays /MySelf/researcher/ and everything after `#/` is the Studio's.
 * A hash that does not start with `#/` is not the Studio's at all — the
 * researcher view is shown instead (App.tsx).
 *
 * THE STUDY IS PART OF THE ADDRESS (D-56): `#/study/<id>/surveys/…` is a page
 * in that study space, and an address with no `study/` prefix is in the
 * project's default study — so every address in use before study spaces
 * still opens what it opened. The prefix is kept apart from the `Route`, which
 * says which page; `studyOfHash` says which study, and `formatRoute` puts the
 * two together. Which study an address names decides nothing about access:
 * the rules and functions check the person against that study's own list.
 *
 * Pure parsing and formatting only; the React side is in router.tsx.
 */

declare const __STUDY__: string;

/** The project's default study: its pages have no `study/` prefix. */
export const DEFAULT_STUDY = __STUDY__ || "ybm";

const STUDY_PREFIX = /^\/study\/([^/?]*)(?=[/?]|$)/;

/**
 * The study an address is in: the one its `study/<id>` prefix names, or the
 * default when it has none. Null when the prefix names something that is not a
 * study id, which is no page at all.
 */
export function studyOfHash(hash: string, defaultStudy: string = DEFAULT_STUDY): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const match = STUDY_PREFIX.exec(raw);
  if (!match) return defaultStudy;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return STUDY_ID_PATTERN.test(id) ? id : null;
}

/** The address without its study prefix: the part `parseHash` reads. */
function withoutStudy(raw: string): string {
  return raw.replace(STUDY_PREFIX, "");
}

export type SurveyTab = "edit" | "preview" | "versions" | "settings";
export const SURVEY_TABS: readonly SurveyTab[] = ["edit", "preview", "versions", "settings"];

export type Route =
  | { name: "login"; next: string | null }
  | { name: "surveys" }
  /** Who has access — study-wide, so reachable before any survey exists. */
  | { name: "access" }
  /** `q` is a question ID (`<instrument>.<key>`) to select, where the tab has one. */
  | { name: "survey"; surveyId: string; tab: SurveyTab; q: string | null }
  | { name: "playground"; tab: "edit" | "preview"; q: string | null }
  | { name: "not_found"; path: string };

/** Survey IDs are composition keys: lowercase snake_case slugs (see @myself/schema `slug`). */
const SURVEY_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_Q = 200;

export function isStudioHash(hash: string): boolean {
  return hash.startsWith("#/");
}

function cleanQ(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  return v && v.length <= MAX_Q ? v : null;
}

/**
 * Where a `next` parameter may send someone after signing in: somewhere in the
 * Studio, and never back to the sign-in page.
 */
export function safeNext(next: string | null): string | null {
  if (!next || !isStudioHash(next)) return null;
  const route = parseHash(next);
  if (route.name === "login" || route.name === "not_found") return null;
  return formatRoute(route, studyOfHash(next) ?? DEFAULT_STUDY);
}

export function parseHash(hash: string): Route {
  const full = hash.startsWith("#") ? hash.slice(1) : hash;
  if (studyOfHash(full) === null) return { name: "not_found", path: splitOnce(full, "?")[0] };
  const raw = withoutStudy(full);
  const [pathPart = "", queryPart = ""] = splitOnce(raw, "?");
  const params = new URLSearchParams(queryPart);
  let segments: string[];
  try {
    segments = pathPart
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return { name: "not_found", path: pathPart };
  }
  const [first, second, third, ...rest] = segments;

  if (first === undefined) return { name: "surveys" };
  if (first === "login" && second === undefined) {
    const next = params.get("next");
    return { name: "login", next: next && isStudioHash(next) ? next : null };
  }
  if (first === "access" && second === undefined) return { name: "access" };
  if (first === "playground") {
    if (second === undefined || second === "edit") return { name: "playground", tab: "edit", q: cleanQ(params.get("q")) };
    if (second === "preview" && third === undefined) return { name: "playground", tab: "preview", q: cleanQ(params.get("q")) };
    return { name: "not_found", path: pathPart };
  }
  if (first === "surveys") {
    if (second === undefined) return { name: "surveys" };
    if (!SURVEY_ID.test(second) || rest.length > 0) return { name: "not_found", path: pathPart };
    const tab = third ?? "edit";
    if (!(SURVEY_TABS as readonly string[]).includes(tab)) return { name: "not_found", path: pathPart };
    const t = tab as SurveyTab;
    const q = t === "edit" || t === "preview" ? cleanQ(params.get("q")) : null;
    return { name: "survey", surveyId: second, tab: t, q };
  }
  return { name: "not_found", path: pathPart };
}

/**
 * A route's address, in a study: the default study's pages keep the addresses
 * they always had, and any other study's carry its `study/<id>` prefix.
 */
export function formatRoute(route: Route, study: string = DEFAULT_STUDY): string {
  const hash = formatPage(route);
  if (study === DEFAULT_STUDY || route.name === "not_found") return hash;
  return `#/study/${encodeURIComponent(study)}${hash.slice(1)}`;
}

function formatPage(route: Route): string {
  switch (route.name) {
    case "login":
      return route.next ? `#/login?${new URLSearchParams({ next: route.next }).toString()}` : "#/login";
    case "surveys":
      return "#/surveys";
    case "access":
      return "#/access";
    case "survey": {
      const base = `#/surveys/${encodeURIComponent(route.surveyId)}/${route.tab}`;
      return route.q ? `${base}?${new URLSearchParams({ q: route.q }).toString()}` : base;
    }
    case "playground": {
      const base = route.tab === "preview" ? "#/playground/preview" : "#/playground";
      return route.q ? `${base}?${new URLSearchParams({ q: route.q }).toString()}` : base;
    }
    case "not_found":
      return `#${route.path.startsWith("/") ? route.path : `/${route.path}`}`;
  }
}

/** Two routes are the same page when only the selected question differs. */
export function samePage(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "survey" && b.name === "survey") return a.surveyId === b.surveyId && a.tab === b.tab;
  if (a.name === "playground" && b.name === "playground") return a.tab === b.tab;
  return formatRoute(a) === formatRoute(b);
}

/** The survey a route belongs to, if any — the unit a draft editor lives for. */
export function surveyOf(route: Route): string | null {
  return route.name === "survey" ? route.surveyId : null;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
