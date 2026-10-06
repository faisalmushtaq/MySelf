import { useId, useMemo, useState } from "react";
import {
  fragmentFromDraft,
  moduleProblems,
  outline,
  recordSavedModule,
  withoutOutsideConditions,
  type Issue,
  type LibrarySaveModuleRequest,
  type PieceSelection,
  type StudioFragment,
} from "@myself/studio";
import { studio, StudioCallError } from "../../data/index.js";
import { refreshLibrary } from "../../data/library.js";
import { plural } from "../../format.js";
import { Dialog } from "../../ui/dialog.js";
import { Button, Field, Notice } from "../../ui/kit.js";
import { useToast } from "../../ui/toast.js";
import { useEditor } from "../context.js";
import type { BlockRef } from "../node/BlockEditor.js";
import { useLibraryUi } from "./LibraryContext.js";
import { moduleIdProblem, moduleSlug, moduleSourcesOf, parseTags } from "./model.js";

/**
 * "Save to library…" (docs/16 §12.6): a block's questions, all of them or
 * some, saved as a module every study space can reuse — or as the next
 * version of the module they came from. Only editable content can be saved;
 * the server checks the piece again and writes the audit row.
 *
 * Once saved, the survey records that its questions are now that module's
 * version (one edit), so a later version saved from elsewhere gives this
 * survey an update notice too.
 */

const NEW = "__new__";

export function SaveModuleDialog({ block, onClose }: { block: BlockRef; onClose: () => void }) {
  const ctx = useEditor();
  const lib = useLibraryUi();
  const toast = useToast();
  const draft = ctx.draft;
  const info = useMemo(
    () => outline(draft).sections.find((s) => s.key === block.sectionKey)?.blocks.find((b) => b.componentIndex === block.componentIndex) ?? null,
    [draft, block.sectionKey, block.componentIndex],
  );
  const questions = info?.questions ?? [];
  const sources = useMemo(() => moduleSourcesOf(draft, questions.map((q) => q.itemKey)), [draft, questions]);

  const [mode, setMode] = useState<string>(() => sources[0]?.moduleId ?? NEW);
  const [title, setTitle] = useState(info?.name ?? "");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(questions.map((q) => q.itemKey)));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof saveError> | null>(null);
  const groupId = useId();

  const source = mode === NEW ? null : (sources.find((s) => s.moduleId === mode) ?? null);
  const effectiveId = idTouched ? id : moduleSlug(title);
  const taken = [...lib.modules.keys()];
  const idError = mode === NEW ? moduleIdProblem(effectiveId, taken) : null;
  const titleError = mode === NEW && !title.trim() ? "Give the module a title." : null;
  const noteError = !note.trim() ? (mode === NEW ? "Say what this module is for, in a line." : "Say what changed in this version.") : null;
  const chosenKeys = questions.map((q) => q.itemKey).filter((k) => chosen.has(k));

  // The piece, built as the server will check it, and what is wrong with it.
  type Built = { fragment: StudioFragment | null; problems: Issue[]; dropped: { itemKey: string | null; block: string | null; reason: string }[]; error: string | null };
  const built = useMemo((): Built => {
    const keys = questions.map((q) => q.itemKey).filter((k) => chosen.has(k));
    if (!info || keys.length === 0) return { fragment: null, problems: [], dropped: [], error: null };
    const selection: PieceSelection =
      keys.length === questions.length
        ? { kind: "block", sectionKey: block.sectionKey, componentIndex: block.componentIndex }
        : { kind: "questions", sectionKey: block.sectionKey, componentIndex: block.componentIndex, itemKeys: keys };
    const moduleId = source?.moduleId ?? (effectiveId || "module");
    try {
      const taken = fragmentFromDraft(draft, selection, { kind: "module", moduleId, version: source ? source.version + 1 : 1, contentHash: "" });
      // A module has to make sense wherever it is added, so a condition about a
      // question outside it is left behind — and said, before it is saved.
      const { fragment, removed } = withoutOutsideConditions(taken);
      const piece = { ...fragment, title: source ? (lib.modules.get(source.moduleId)?.title ?? fragment.title) : title.trim() || fragment.title };
      return { fragment: piece, problems: moduleProblems(piece), dropped: removed, error: null };
    } catch (e) {
      return { fragment: null, problems: [], dropped: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [info, draft, block.sectionKey, block.componentIndex, chosen, questions, source, effectiveId, title, lib.modules]);

  const blocking = built.problems.filter((p) => p.severity === "error");
  const valid = !idError && !titleError && !noteError && chosenKeys.length > 0 && !!built.fragment && blocking.length === 0;

  const save = () => {
    setSubmitted(true);
    setError(null);
    if (!valid || !built.fragment) return;
    const fragment = built.fragment;
    const request: LibrarySaveModuleRequest = {
      surveyId: ctx.surveyId,
      draftRevision: ctx.editor.revision,
      note: note.trim(),
      fragment,
      ...(source
        ? { moduleId: source.moduleId, baseVersion: source.version }
        : { create: { moduleId: effectiveId, title: title.trim(), description: description.trim(), tags: parseTags(tags) } }),
    };
    const name = source ? (lib.modules.get(source.moduleId)?.title ?? source.moduleId) : title.trim();
    setBusy(true);
    studio
      .librarySaveModule(request)
      .then((res) => {
        const saved: StudioFragment = { ...fragment, origin: { kind: "module", moduleId: res.moduleId, version: res.version, contentHash: res.contentHash } };
        // This survey's questions are now that version: a later one notifies here too.
        ctx.run(`Record “${name}” v${res.version} as saved from here`, (d) =>
          recordSavedModule(d, saved, { by: ctx.user.uid, byEmail: ctx.user.email ?? "", at: new Date().toISOString() }).draft,
        );
        refreshLibrary();
        toast.success(
          source ? `Saved version ${res.version} of “${name}”` : `Saved “${name}” to the library`,
          "Every study space can now add it from the library.",
        );
        onClose();
      })
      .catch((e: unknown) => {
        const refused = saveError(e, name, source?.version ?? null);
        // Someone saved first: read the library again, so this survey's notice for their version appears.
        if (refused.conflict) refreshLibrary();
        setError(refused);
      })
      .finally(() => setBusy(false));
  };

  if (!info) return null;
  const toggle = (key: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Dialog
      title="Save to library"
      onClose={onClose}
      dismissable={!busy}
      width={600}
      description={<p className="stn-flush">“{info.name}”, for every study space to reuse. Surveys that use it are told when a newer version is saved.</p>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon="library" busy={busy} onClick={save}>
            {source ? `Save version ${source.version + 1}` : "Save to library"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {sources.length > 0 ? (
          <fieldset className="stp-fieldset">
            <legend className="st-field-label">Save as</legend>
            {sources.map((s) => (
              <label key={s.moduleId} className="stp-radio">
                <input type="radio" name="save-as" checked={mode === s.moduleId} onChange={() => setMode(s.moduleId)} />
                <span>
                  <strong>
                    A new version of ‘{lib.modules.get(s.moduleId)?.title ?? s.moduleId}’ (v{s.version + 1})
                  </strong>
                  <small>Its questions came from version {s.version}. Other surveys using it are told and can choose to update.</small>
                </span>
              </label>
            ))}
            <label className="stp-radio">
              <input type="radio" name="save-as" checked={mode === NEW} onChange={() => setMode(NEW)} />
              <span>
                <strong>A new module</strong>
                <small>Separate from the one it came from.</small>
              </span>
            </label>
          </fieldset>
        ) : null}

        {mode === NEW ? (
          <>
            <Field label="Title" error={submitted ? titleError : null}>
              {(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
            </Field>
            <Field
              label="Module ID"
              hint="Lower-case letters, numbers and underscores. It can’t be changed later."
              error={submitted || idTouched ? idError : null}
            >
              {(p) => (
                <input
                  {...p}
                  className="st-input st-input-mono"
                  value={effectiveId}
                  onChange={(e) => {
                    setIdTouched(true);
                    setId(e.target.value.trim());
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label="Description" optional>
              {(p) => <textarea {...p} className="st-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
            <Field label="Tags" optional hint="Separated by commas, for example: sleep, wellbeing">
              {(p) => <input {...p} className="st-input" value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" />}
            </Field>
          </>
        ) : null}

        <fieldset className="stp-fieldset stl-save-questions" aria-describedby={`${groupId}-count`}>
          <legend className="st-field-label">Questions</legend>
          <p id={`${groupId}-count`} className="stl-meta">
            {plural(chosenKeys.length, "question")} of {questions.length} chosen
          </p>
          <ul className="stl-questions">
            {questions.map((q) => (
              <li key={q.itemKey}>
                <div className="stl-check">
                  <input id={`${groupId}-${q.itemKey}`} type="checkbox" checked={chosen.has(q.itemKey)} onChange={() => toggle(q.itemKey)} />
                  <label htmlFor={`${groupId}-${q.itemKey}`}>
                    <span className="stl-q-text">{q.text || "Untitled question"}</span>
                    <span className="stl-q-id">{q.itemKey}</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
          {submitted && chosenKeys.length === 0 ? <p className="st-field-msg st-field-msg-error">Choose at least one question.</p> : null}
        </fieldset>

        <Field label={source ? "What changed in this version" : "Note"} error={submitted ? noteError : null}>
          {(p) => (
            <input
              {...p}
              className="st-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoComplete="off"
              placeholder={source ? "For example: Reworded question 2 after the pilot." : "For example: Sleep habits, as piloted in 2026."}
            />
          )}
        </Field>

        {source && (lib.modules.get(source.moduleId)?.latestVersion ?? 0) > source.version ? (
          <Notice tone="warn" title="The library has a newer version">
            ‘{lib.modules.get(source.moduleId)?.title ?? source.moduleId}’ is at version {lib.modules.get(source.moduleId)?.latestVersion}, and this
            survey has version {source.version}. Review and take the update on this block first; a version saved from here now would be refused.
          </Notice>
        ) : null}
        {built.error ? <Notice tone="error">{built.error}</Notice> : null}
        {built.dropped.length > 0 ? (
          <Notice tone="warn" title="Saved without these conditions">
            <p className="stn-flush">They test questions outside what is being saved, so they wouldn&rsquo;t make sense in another survey. This survey keeps them.</p>
            <ul className="stl-bullets">
              {built.dropped.map((c, i) => (
                <li key={i}>
                  {c.itemKey ? <code>{c.itemKey}</code> : <>Block “{c.block}”</>}: {c.reason}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {built.problems.length > 0 ? (
          <Notice tone={blocking.length > 0 ? "error" : "warn"} title={blocking.length > 0 ? "This can’t be saved yet" : "Worth a look before saving"}>
            <ul className="stl-bullets">
              {built.problems.map((p, i) => (
                <li key={i}>
                  {p.message}
                  {p.location.itemKey ? <span className="stl-meta"> ({p.location.itemKey})</span> : null}
                  {p.hint ? <span className="stl-meta"> — {p.hint}</span> : null}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="error" title={error.title}>
            <p className="stn-flush">{error.body}</p>
            {error.issues && error.issues.length > 0 ? (
              <ul className="stl-bullets">
                {error.issues.map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** A refused save, in words — above all, someone else saving a newer version first. */
export function saveError(e: unknown, name: string, base: number | null): { title: string; body: string; issues?: Issue[]; conflict?: boolean } {
  if (!(e instanceof StudioCallError)) return { title: "Not saved", body: "The module couldn’t be saved. Try again." };
  const d = e.details;
  if (d?.kind === "conflict" || (base !== null && e.code === "aborted")) {
    const latest = d?.kind === "conflict" ? d.currentRevision : null;
    return {
      conflict: true,
      title: "Someone saved a newer version first",
      body:
        `${latest ? `“${name}” is now at version ${latest}` : `“${name}” has a newer version than ${base ?? "the one this survey has"}`}, saved after this survey took version ${base ?? "its copy"}, so nothing was saved. ` +
        "The newer version is now offered on this block: review it and take the update, then save your changes as the next version.",
    };
  }
  if (e.code === "already-exists") {
    return { title: "That module ID is taken", body: "There’s already a module with this ID (it may be retired). Choose another ID." };
  }
  if (d?.kind === "invalid") return { title: "The server didn’t accept this module", body: e.message, issues: d.issues };
  if (d?.kind === "forbidden" || e.code === "permission-denied") {
    return { title: "Not saved", body: "Saving to the library needs editor access to this study space." };
  }
  return { title: "Not saved", body: e.message };
}
