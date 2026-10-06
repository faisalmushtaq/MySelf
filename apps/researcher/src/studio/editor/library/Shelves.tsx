import { useMemo } from "react";
import { outline, validatedCatalogue, type LibraryModuleResponse, type StudioDraft, type StudioFragment, type ValidatedEntry } from "@myself/studio";
import { type Loadable } from "../../data/index.js";
import { releaseRefKey, useLibraryCatalogue, useLibraryModules, useReleaseDrafts, type ReleaseRef } from "../../data/library.js";
import { formatDate, formatDateTime, plural, toDate, versionLabel } from "../../format.js";
import { usePlaygroundMode } from "../../mode.js";
import { useStudy } from "../../router.js";
import { LoadError } from "../../shell/common.js";
import { Icon } from "../../ui/icons.js";
import { Badge, EmptyState, Notice, Skeleton } from "../../ui/kit.js";
import { filterModules, matches, matchingQuestions, normalise, orderCatalogue, type CatalogueSurvey } from "./model.js";
import { FragmentQuestions, ReleasePicker } from "./PiecePreview.js";

/**
 * The library's three shelves (docs/16 §12.2), each a list on the left and
 * what is chosen from it on the right: saved modules, the validated
 * questionnaires, and every published version of every survey in every study
 * space.
 */

/**
 * A shelf that couldn't be read. The playground has no study to read saved
 * modules or published surveys from, which is said as that rather than as a
 * failure; the validated questionnaires are part of the build and always there.
 */
function ShelfError({ error, retry }: { error: string; retry: () => void }) {
  if (usePlaygroundMode()) {
    return (
      <p className="stl-empty-line">
        The playground isn&rsquo;t connected to a study, so only the validated questionnaires are here. Saved modules and published
        surveys are read from the study.
      </p>
    );
  }
  return <LoadError error={error} retry={retry} />;
}

// ── Saved modules ─────────────────────────────────────────────────────────

export function ModuleList({ query, selected, onSelect }: { query: string; selected: string | null; onSelect: (moduleId: string) => void }) {
  const list = useLibraryModules();
  if (list.status === "loading") return <Skeleton lines={5} label="Loading the saved modules" />;
  if (list.status === "error") return <ShelfError error={list.error} retry={list.retry} />;
  if (list.data.length === 0) {
    return (
      <EmptyState icon="library" title="No saved modules yet">
        <p>Save a block from any survey with “Save to library…” on its menu, and it appears here for every study space.</p>
      </EmptyState>
    );
  }
  const shown = filterModules(list.data, query, null);
  if (shown.length === 0) return <p className="stl-empty-line">No saved module matches “{query.trim()}”.</p>;
  return (
    <ul className="stl-list" aria-label="Saved modules">
      {shown.map((m) => (
        <li key={m.moduleId}>
          <button type="button" className="stl-item" aria-pressed={selected === m.moduleId} onClick={() => onSelect(m.moduleId)}>
            <span className="stl-item-title">{m.title}</span>
            <span className="stl-item-meta">
              v{m.latestVersion} · {plural(m.questionCount, "question")}
            </span>
            {m.tags.length > 0 ? (
              <span className="stl-tags">
                {m.tags.map((t) => (
                  <span key={t} className="stl-tag">
                    {t}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ModulePreview({ answer, query }: { answer: Loadable<LibraryModuleResponse>; query: string }) {
  if (answer.status === "loading") return <Skeleton lines={6} label="Loading the module" />;
  if (answer.status === "error") return <LoadError error={answer.error} retry={answer.retry} />;
  const { module, version } = answer.data;
  return (
    <div className="stl-detail">
      <header className="stl-detail-head">
        <h3 className="stl-detail-title">{module.title}</h3>
        <p className="stl-meta">
          <span className="stl-mono">{module.moduleId}</span> · v{version.version} · {plural(version.questionCount, "question")}
        </p>
        {module.description ? <p className="stl-detail-desc">{module.description}</p> : null}
        {module.tags.length > 0 ? (
          <p className="stl-tags">
            {module.tags.map((t) => (
              <span key={t} className="stl-tag">
                {t}
              </span>
            ))}
          </p>
        ) : null}
        <p className="stl-meta">
          Saved by {version.savedByEmail} on {formatDateTime(toDate(version.savedAt))}
          {version.note ? <>: “{version.note}”</> : null}
        </p>
      </header>
      <p className="stl-whole">
        <Icon name="info" size={14} /> Added whole. When a newer version is saved, this survey is told and can choose to take it.
      </p>
      <FragmentQuestions fragment={version.fragment} query={query} />
    </div>
  );
}

// ── Validated questionnaires ──────────────────────────────────────────────

/** The validated questionnaires, worked out once: the library is part of the build. */
let catalogue: { entries: ValidatedEntry[]; error: string | null } | null = null;
export function validatedEntries(): { entries: ValidatedEntry[]; error: string | null } {
  if (!catalogue) {
    try {
      catalogue = { entries: validatedCatalogue("en-GB"), error: null };
    } catch {
      // Not kept: the next look tries again.
      return { entries: [], error: "The validated questionnaires couldn’t be listed." };
    }
  }
  return catalogue;
}

export function ValidatedList({ query, selected, onSelect }: { query: string; selected: string | null; onSelect: (refKey: string) => void }) {
  const { entries, error } = validatedEntries();
  if (error) return <Notice tone="error">{error}</Notice>;
  const shown = entries.filter((e) => matches(query, e.name, e.abbreviation, e.instrument, e.audience, e.refKey));
  if (shown.length === 0) return <p className="stl-empty-line">No validated questionnaire matches “{query.trim()}”.</p>;
  return (
    <ul className="stl-list" aria-label="Validated questionnaires">
      {shown.map((e) => (
        <li key={e.refKey}>
          <button type="button" className="stl-item" aria-pressed={selected === e.refKey} onClick={() => onSelect(e.refKey)}>
            <span className="stl-item-title">
              {e.abbreviation ? `${e.abbreviation} · ` : ""}
              {e.name}
            </span>
            <span className="stl-item-meta">
              {plural(e.questionCount, "question")}
              {e.audience ? ` · ${e.audience}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ValidatedPreview({
  entry,
  fragment,
  error,
  query,
  inDraft,
}: {
  entry: ValidatedEntry | null;
  fragment: StudioFragment | null;
  error: string | null;
  query: string;
  /** The version of this questionnaire the draft already has, if any. */
  inDraft: string | null;
}) {
  if (error || !fragment || !entry) return <Notice tone="error">{error ?? "This questionnaire couldn’t be opened."}</Notice>;
  return (
    <div className="stl-detail">
      <header className="stl-detail-head">
        <h3 className="stl-detail-title">{entry.name}</h3>
        <p className="stl-meta">
          <span className="stl-mono">{entry.refKey}</span> · {plural(entry.questionCount, "question")}
          {entry.audience ? ` · ${entry.audience}` : ""}
        </p>
        <p className="stl-detail-desc">{entry.licence}</p>
      </header>
      <p className="stl-whole">
        <Icon name="lock" size={14} /> Added whole and unchanged, exactly as licensed, with its answer options and scoring.
      </p>
      {inDraft ? (
        <Notice tone={inDraft === entry.version ? "neutral" : "warn"}>
          {inDraft === entry.version
            ? "This survey already has this questionnaire, so adding it again changes nothing."
            : `This survey already has version ${inDraft} of it, and a survey holds only one version of a validated questionnaire.`}
        </Notice>
      ) : null}
      <FragmentQuestions fragment={fragment} query={query} />
    </div>
  );
}

// ── Published surveys ─────────────────────────────────────────────────────

export interface ReleaseChoice {
  study: string;
  studyTitle: string;
  surveyId: string;
  surveyTitle: string;
  version: string;
  hash: string;
  live: string | null;
  versions: CatalogueSurvey["versions"];
}

const SEARCH_MIN = 2;

/**
 * Every study's surveys, this study space first. A search matches a survey's
 * title or ID, and the questions of its latest version (wording, ID, variable,
 * block name), which are fetched and verified for the purpose.
 */
export function PublishedList({
  query,
  selected,
  onSelect,
}: {
  query: string;
  selected: ReleaseChoice | null;
  onSelect: (choice: ReleaseChoice) => void;
}) {
  const here = useStudy();
  const cat = useLibraryCatalogue();
  const studies = useMemo(() => (cat.status === "ready" ? orderCatalogue(cat.data, here) : []), [cat, here]);
  const searching = normalise(query).length >= SEARCH_MIN;
  const latest = useMemo<ReleaseRef[]>(
    () => (searching ? studies.flatMap((s) => s.surveys.map((v) => ({ study: s.study, hash: v.versions[0]!.hash }))) : []),
    [searching, studies],
  );
  const loaded = useReleaseDrafts(latest);
  const hits = useMemo(() => {
    const out = new Map<string, number>();
    if (!searching) return out;
    for (const [key, draft] of loaded.drafts) out.set(key, matchingQuestions(draft, outline(draft), query).size);
    return out;
  }, [loaded.drafts, query, searching]);

  if (cat.status === "loading") return <Skeleton lines={5} label="Loading the published surveys" />;
  if (cat.status === "error") return <ShelfError error={cat.error} retry={cat.retry} />;
  if (studies.length === 0) {
    return (
      <EmptyState icon="library" title="Nothing published yet">
        <p>Every published version of every survey, in every study space, appears here.</p>
      </EmptyState>
    );
  }
  const groups = studies
    .map((s) => ({
      ...s,
      surveys: s.surveys.filter((v) => {
        if (!searching) return true;
        return matches(query, v.title, v.surveyId) || (hits.get(releaseRefKey({ study: s.study, hash: v.versions[0]!.hash })) ?? 0) > 0;
      }),
    }))
    .filter((s) => s.surveys.length > 0);

  return (
    <div className="stl-groups">
      {searching && loaded.pending ? (
        <p className="stl-meta" role="status">
          Searching the latest versions…
        </p>
      ) : null}
      {groups.length === 0 && !loaded.pending ? <p className="stl-empty-line">No survey or question matches “{query.trim()}”.</p> : null}
      {groups.map((s) => (
        <section key={s.study} className="stl-group" aria-label={`Study space: ${s.title}`}>
          <h3 className="stl-group-title">
            <span>{s.title}</span>
            {s.here ? <Badge tone="muted">This study space</Badge> : null}
            {s.status === "closed" ? <Badge tone="muted">Closed</Badge> : null}
          </h3>
          <ul className="stl-list">
            {s.surveys.map((v) => {
              const newest = v.versions[0]!;
              const n = hits.get(releaseRefKey({ study: s.study, hash: newest.hash }));
              const on = selected?.study === s.study && selected.surveyId === v.surveyId;
              return (
                <li key={v.surveyId}>
                  <button
                    type="button"
                    className="stl-item"
                    aria-pressed={on}
                    onClick={() =>
                      onSelect({
                        study: s.study,
                        studyTitle: s.title,
                        surveyId: v.surveyId,
                        surveyTitle: v.title,
                        version: newest.version,
                        hash: newest.hash,
                        live: v.live,
                        versions: v.versions,
                      })
                    }
                  >
                    <span className="stl-item-title">{v.title}</span>
                    <span className="stl-item-meta">
                      <span className="stl-mono">{v.surveyId}</span> · {v.live ? `live ${versionLabel(v.live)}` : "not live"}
                      {n ? ` · ${plural(n, "match", "matches")}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function PublishedPreview({
  choice,
  source,
  query,
  picked,
  onPicked,
  onVersion,
}: {
  choice: ReleaseChoice;
  source: Loadable<StudioDraft>;
  query: string;
  picked: ReadonlySet<string>;
  onPicked: (next: Set<string>) => void;
  onVersion: (version: string, hash: string) => void;
}) {
  const here = useStudy();
  return (
    <div className="stl-detail">
      <header className="stl-detail-head">
        <h3 className="stl-detail-title">{choice.surveyTitle}</h3>
        <p className="stl-meta">
          <span className="stl-mono">{choice.surveyId}</span>
          {choice.study === here ? " · this study space" : ` · study space “${choice.studyTitle}”`}
        </p>
        <div className="stl-version">
          <label className="st-field-label" htmlFor="stl-version">
            Version
          </label>
          <select
            id="stl-version"
            className="st-select"
            value={choice.version}
            onChange={(e) => {
              const v = choice.versions.find((x) => x.version === e.target.value);
              if (v) onVersion(v.version, v.hash);
            }}
          >
            {choice.versions.map((v) => (
              <option key={v.version} value={v.version}>
                {versionLabel(v.version)}
                {v.version === choice.live ? " · live" : ""} · {formatDate(toDate(v.publishedAt))}
              </option>
            ))}
          </select>
        </div>
      </header>
      {source.status === "loading" ? (
        <Skeleton lines={6} label="Opening this version" />
      ) : source.status === "error" ? (
        <LoadError error={source.error} retry={source.retry} />
      ) : (
        <>
          <p className="stl-whole">
            <Icon name="info" size={14} /> Tick questions, blocks or whole sections. Copies keep their question IDs and variables, so their data lines up with this version’s.
          </p>
          <ReleasePicker source={source.data} query={query} picked={picked} onPicked={onPicked} />
        </>
      )}
    </div>
  );
}
