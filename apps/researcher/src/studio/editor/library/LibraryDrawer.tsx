import { useId, useMemo, useState } from "react";
import {
  describeInsert,
  fragmentFromDraft,
  outline,
  questionCount,
  shortText,
  validatedFragment,
  type FragmentOrigin,
  type InsertOptions,
  type InsertReport,
  type StudioFragment,
} from "@myself/studio";
import { useLibraryModule, useReleaseDraft } from "../../data/library.js";
import { plural } from "../../format.js";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton, Notice } from "../../ui/kit.js";
import { TabPanel, Tabs } from "../../ui/tabs.js";
import { useEditor } from "../context.js";
import { ProtectedReasonDialog } from "./InsertDialogs.js";
import {
  combineReports,
  defaultTarget,
  insertPieces,
  pickedCount,
  piecesFor,
  protectedInFragment,
  targetWords,
  type InsertOutcome,
  type TargetChoice,
} from "./model.js";
import {
  ModuleList,
  ModulePreview,
  PublishedList,
  PublishedPreview,
  ValidatedList,
  ValidatedPreview,
  validatedEntries,
  type ReleaseChoice,
} from "./Shelves.js";
import { TargetPicker } from "./TargetPicker.js";

/**
 * The library drawer (docs/16 §12.2–§12.3): browse a shelf, choose what to
 * take, say where it goes, and add it — as one edit, made through `ctx.run`
 * like any other, so it is undone, saved, validated and published exactly as
 * a change typed by hand. A copy keeps its question IDs and variables; the
 * model renames only on a clash and says so, and this says it on to the
 * researcher.
 */

type Shelf = "modules" | "validated" | "published";

const SHELVES: { value: Shelf; label: string }[] = [
  { value: "modules", label: "Saved modules" },
  { value: "validated", label: "Validated questionnaires" },
  { value: "published", label: "Published surveys" },
];

const PLACEHOLDER: Record<Shelf, string> = {
  modules: "Search modules by title, description or tag",
  validated: "Search questionnaires by name",
  published: "Search surveys, question wording, variables and blocks",
};

const TAB_KEY = "studio.library.shelf";

function rememberedShelf(): Shelf {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    return v === "modules" || v === "validated" || v === "published" ? v : "modules";
  } catch {
    return "modules";
  }
}

/** A piece ready to add: what it is called, how many questions, and how to make it. */
interface Ready {
  title: string;
  count: number;
  /** Throws, with the model's own words, when the piece cannot be taken. */
  build: () => StudioFragment[];
  wholeSection: boolean;
}

export interface Added {
  outcome: InsertOutcome;
  summary: string[];
}

export function LibraryDrawer({
  initialTarget,
  onClose,
  onAdded,
}: {
  initialTarget: TargetChoice | null;
  onClose: () => void;
  onAdded: (added: Added) => void;
}) {
  const ctx = useEditor();
  const idBase = useId().replace(/:/g, "");
  const o = useMemo(() => outline(ctx.draft), [ctx.draft]);
  const [shelf, setShelf] = useState<Shelf>(rememberedShelf);
  const [query, setQuery] = useState("");
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [refKey, setRefKey] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseChoice | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [target, setTarget] = useState<TargetChoice | null>(() => initialTarget ?? defaultTarget(o, ctx.selection));
  const [asking, setAsking] = useState<{ fragments: StudioFragment[]; modules: { instrument: string; name: string }[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const moduleAnswer = useLibraryModule(moduleId);
  const validated = useMemo(() => {
    if (!refKey) return null;
    const entry = validatedEntries().entries.find((e) => e.refKey === refKey) ?? null;
    try {
      return { entry, fragment: validatedFragment(refKey), error: null };
    } catch (error) {
      return { entry, fragment: null, error: error instanceof Error ? error.message : "This questionnaire couldn’t be opened." };
    }
  }, [refKey]);
  const source = useReleaseDraft(release ? { study: release.study, hash: release.hash } : null);
  const sourceOutline = useMemo(() => (source.status === "ready" ? outline(source.data) : null), [source]);

  const switchShelf = (next: Shelf) => {
    setShelf(next);
    setProblem(null);
    try {
      sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering the shelf is a convenience; without storage it starts on the first.
    }
  };

  // ── What would be added ─────────────────────────────────────────────────
  const ready: Ready | null = useMemo(() => {
    if (shelf === "modules" && moduleId && moduleAnswer.status === "ready") {
      const fragment = moduleAnswer.data.version.fragment;
      return { title: moduleAnswer.data.module.title, count: questionCount(fragment), build: () => [fragment], wholeSection: false };
    }
    if (shelf === "validated" && validated?.fragment) {
      const fragment = validated.fragment;
      return { title: validated.entry?.name ?? fragment.title, count: questionCount(fragment), build: () => [fragment], wholeSection: false };
    }
    if (shelf === "published" && release && source.status === "ready" && sourceOutline) {
      const pieces = piecesFor(sourceOutline, picked);
      const origin: FragmentOrigin = { kind: "release", study: release.study, surveyId: release.surveyId, version: release.version, hash: release.hash };
      return {
        title: release.surveyTitle,
        count: pickedCount(sourceOutline, picked),
        build: () => pieces.map((p) => fragmentFromDraft(source.data, p, origin)),
        wholeSection: pieces.some((p) => p.kind === "section"),
      };
    }
    return null;
  }, [shelf, moduleId, moduleAnswer, validated, release, source, sourceOutline, picked]);

  const inDraft = useMemo(() => {
    const instrument = validated?.entry?.instrument;
    if (!instrument) return null;
    const def = Object.values(ctx.draft.instruments).find((d) => d.instrument === instrument);
    return def ? String((def as { version?: unknown }).version ?? "") || null : null;
  }, [validated, ctx.draft]);

  // ── Adding ──────────────────────────────────────────────────────────────
  const blocked = !ctx.canEdit
    ? (ctx.readOnlyReason ?? "This draft can’t be changed.")
    : ctx.publishedStatus !== "ready"
      ? "Checking what this survey has published, so copies are never given an ID it has used…"
      : null;

  const insert = (fragments: StudioFragment[], reason: string | null) => {
    if (!target || !ready) return;
    const opts: InsertOptions = {
      by: ctx.user.uid,
      byEmail: ctx.user.email ?? "",
      at: new Date().toISOString(),
      ...(ctx.reserved ? { reserved: ctx.reserved } : {}),
      ...(reason ? { protectedReason: reason } : {}),
    };
    // Tried first, so a refusal is said here, beside what was chosen, rather
    // than in a toast behind the drawer. Nothing is changed by trying.
    try {
      insertPieces(ctx.draft, fragments, target, opts);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    const out: { reports?: InsertReport[] } = {};
    const ok = ctx.run(`Add “${shortText(ready.title, 40)}” from the library`, (d) => {
      const result = insertPieces(d, fragments, target, opts);
      out.reports = result.reports;
      return result.draft;
    });
    if (!ok || !out.reports) return;
    const summary = out.reports.map((r) => {
      try {
        return describeInsert(r);
      } catch {
        return "";
      }
    });
    onAdded({ outcome: combineReports(out.reports), summary: summary.filter(Boolean) });
  };

  const add = () => {
    setProblem(null);
    if (!ready || !target) return;
    let fragments: StudioFragment[];
    try {
      fragments = ready.build();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    const guarded = new Map<string, string>();
    for (const f of fragments) for (const m of protectedInFragment(f)) guarded.set(m.instrument, m.name);
    if (guarded.size > 0) {
      setAsking({ fragments, modules: [...guarded].map(([instrument, name]) => ({ instrument, name })) });
      return;
    }
    insert(fragments, null);
  };

  const count = ready?.count ?? 0;
  const addLabel = count === 0 ? "Add questions" : `Add ${plural(count, "question")}`;
  const titleForNew = ready?.title ?? "New section";

  return (
    <Dialog
      title="Library"
      placement="side"
      width={1040}
      onClose={onClose}
      className="stl-drawer"
      initialFocus={`#${CSS.escape(`${idBase}-search`)}`}
      footer={
        <div className="stl-foot">
          {target ? (
            <TargetPicker o={o} value={target} onChange={setTarget} defaultTitle={titleForNew} disabled={!ctx.canEdit} />
          ) : (
            <span className="stl-meta">This survey has no section to add to.</span>
          )}
          <div className="stl-foot-actions">
            <p className="stl-meta stl-foot-where" aria-live="polite">
              {ready && count > 0 && target ? (
                <>
                  {plural(count, "question")} {ready.wholeSection ? "(a whole section comes as a new section) " : ""}
                  {targetWords(o, target)}
                </>
              ) : shelf === "published" ? (
                "Tick what to copy."
              ) : (
                "Choose what to add."
              )}
            </p>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon="plus" onClick={add} disabled={!ready || count === 0 || !target || !!blocked} title={blocked ?? undefined}>
              {addLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className="stl-top">
        <Tabs label="Library shelves" idBase={idBase} value={shelf} onChange={switchShelf} tabs={SHELVES} />
        <div className="stl-search">
          <Icon name="search" size={14} />
          <input
            id={`${idBase}-search`}
            type="search"
            className="st-input"
            placeholder={PLACEHOLDER[shelf]}
            aria-label={PLACEHOLDER[shelf]}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query ? <IconButton icon="close" size="sm" label="Clear the search" onClick={() => setQuery("")} /> : null}
        </div>
      </div>
      <TabPanel idBase={idBase} value={shelf}>
        <div className="stl-split">
          <div className="stl-list-col">
            {shelf === "modules" ? (
              <ModuleList query={query} selected={moduleId} onSelect={(id) => (setModuleId(id), setProblem(null))} />
            ) : shelf === "validated" ? (
              <ValidatedList query={query} selected={refKey} onSelect={(k) => (setRefKey(k), setProblem(null))} />
            ) : (
              <PublishedList
                query={query}
                selected={release}
                onSelect={(choice) => {
                  setRelease(choice);
                  setPicked(new Set());
                  setProblem(null);
                }}
              />
            )}
          </div>
          <div className="stl-preview-col">
            {problem ? (
              <Notice tone="error" title="This can’t be added">
                {problem}
              </Notice>
            ) : null}
            {blocked && ctx.canEdit === false ? <Notice tone="neutral">{blocked}</Notice> : null}
            {shelf === "modules" ? (
              moduleId ? (
                <ModulePreview answer={moduleAnswer} query={query} />
              ) : (
                <Hint>Choose a saved module to see its questions.</Hint>
              )
            ) : shelf === "validated" ? (
              validated ? (
                <ValidatedPreview entry={validated.entry} fragment={validated.fragment} error={validated.error} query={query} inDraft={inDraft} />
              ) : (
                <Hint>Choose a questionnaire to see its questions.</Hint>
              )
            ) : release ? (
              <PublishedPreview
                choice={release}
                source={source}
                query={query}
                picked={picked}
                onPicked={(next) => {
                  setPicked(next);
                  setProblem(null);
                }}
                onVersion={(version, hash) => {
                  setRelease({ ...release, version, hash });
                  setPicked(new Set());
                  setProblem(null);
                }}
              />
            ) : (
              <Hint>Choose a survey. Its latest version opens first; earlier ones are a choice away.</Hint>
            )}
          </div>
        </div>
      </TabPanel>
      {asking ? (
        <ProtectedReasonDialog
          modules={asking.modules}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => {
            const fragments = asking.fragments;
            setAsking(null);
            insert(fragments, reason);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function Hint({ children }: { children: string }) {
  return (
    <div className="stl-hint">
      <Icon name="library" size={24} />
      <p>{children}</p>
    </div>
  );
}
