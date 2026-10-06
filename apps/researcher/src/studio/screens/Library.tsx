import { useId, useMemo, useState } from "react";
import { atLeast, type LibraryModuleSummary } from "@myself/studio";
import { studio, StudioCallError, useStudioSession } from "../data/index.js";
import { refreshLibrary, useLibraryModule, useLibraryModules } from "../data/library.js";
import { allTags, filterModules, parseTags } from "../editor/library/model.js";
import { FragmentQuestions } from "../editor/library/PiecePreview.js";
import { formatDateTime, formatRelative, plural, toDate } from "../format.js";
import { LoadError } from "../shell/common.js";
import { PageHead, Shell, studyTabs } from "../shell/Shell.js";
import { ConfirmDialog, Dialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { Badge, Button, EmptyState, Field, IconButton, Notice, Skeleton, Switch } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";
import "../editor/library/library.css";

/**
 * The item library's saved modules (D-57, docs/16 §12.6), for the whole
 * project: what each is for, its versions (what changed, who saved it, when,
 * from which survey), and keeping it tidy — editing its title, description and
 * tags, and retiring a module that should no longer be used (surveys that
 * use it keep their copies; nothing is ever deleted). Adding a module to a
 * survey happens in the editor's library.
 *
 * The server decides who may do what: any editor may change the words, only
 * a module's creator or a project owner may retire it. A refusal is shown as
 * the server words it.
 */
export function LibraryScreen() {
  const [showRetired, setShowRetired] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const modules = useLibraryModules(showRetired);
  const searchId = useId();

  const tags = useMemo(() => (modules.status === "ready" ? allTags(modules.data) : []), [modules]);
  const shown = useMemo(() => (modules.status === "ready" ? filterModules(modules.data, query, tag) : []), [modules, query, tag]);

  return (
    <Shell tabs={studyTabs("library")} navLabel="Study space">
      <div className="stp-page">
        <PageHead
          title="Library"
          lede="Modules saved for every study space to reuse. Add them, validated questionnaires and questions from any published survey from the editor’s Library."
        />
        <div className="stl-page-tools">
          <div className="stl-search">
            <Icon name="search" size={14} />
            <input
              id={searchId}
              type="search"
              className="st-input"
              placeholder="Search by title, description or tag"
              aria-label="Search the saved modules by title, description or tag"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? <IconButton icon="close" size="sm" label="Clear the search" onClick={() => setQuery("")} /> : null}
          </div>
          <Switch label="Show retired" checked={showRetired} onChange={setShowRetired} />
        </div>
        {tags.length > 0 ? (
          <div className="stl-chips" role="group" aria-label="Show only the tag">
            {tags.map((t) => (
              <button key={t} type="button" className="stl-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                {tag === t ? <Icon name="check" size={12} /> : null}
                {t}
              </button>
            ))}
          </div>
        ) : null}

        {modules.status === "loading" ? (
          <Skeleton lines={5} label="Loading the saved modules" />
        ) : modules.status === "error" ? (
          <LoadError error={modules.error} retry={modules.retry} />
        ) : modules.data.length === 0 ? (
          <EmptyState icon="library" title={showRetired ? "No saved modules" : "No saved modules yet"}>
            <p>In a survey&rsquo;s editor, choose “Save to library…” on a block&rsquo;s menu. It then appears here for every study space.</p>
          </EmptyState>
        ) : shown.length === 0 ? (
          <p className="stp-muted">No saved module matches{query.trim() ? ` “${query.trim()}”` : ""}{tag ? ` with the tag “${tag}”` : ""}.</p>
        ) : (
          <div className="stp-table-wrap">
            <table className="stp-table stl-modules" aria-label="Saved modules">
              <thead>
                <tr>
                  <th scope="col">Module</th>
                  <th scope="col" className="stp-hide-narrow">
                    Tags
                  </th>
                  <th scope="col">Latest</th>
                  <th scope="col" className="stp-hide-narrow">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <ModuleRow key={m.moduleId} module={m} onOpen={() => setOpen(m.moduleId)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open ? <ModuleDialog moduleId={open} onClose={() => setOpen(null)} /> : null}
    </Shell>
  );
}

function ModuleRow({ module: m, onOpen }: { module: LibraryModuleSummary; onOpen: () => void }) {
  return (
    <tr>
      <th scope="row" className="stp-cell-title">
        <button type="button" className="stp-textlink stl-row-title" onClick={onOpen} aria-haspopup="dialog">
          {m.title}
        </button>
        {m.retired ? (
          <>
            {" "}
            <Badge tone="muted">Retired</Badge>
          </>
        ) : null}
        <span className="stp-srow-meta">
          <span className="stp-id">{m.moduleId}</span>
          {m.description ? <span className="stl-row-desc"> · {m.description}</span> : null}
        </span>
      </th>
      <td className="stp-hide-narrow">
        <span className="stl-tags">
          {m.tags.map((t) => (
            <span key={t} className="stl-tag">
              {t}
            </span>
          ))}
        </span>
      </td>
      <td>
        v{m.latestVersion} <span className="stp-meta">· {plural(m.questionCount, "question")}</span>
      </td>
      <td className="stp-hide-narrow">
        <span className="stp-muted" title={formatDateTime(toDate(m.updatedAt))}>
          {formatRelative(toDate(m.updatedAt))}
        </span>
      </td>
    </tr>
  );
}

/** One module: what it is, its versions, its questions, and what can be done with it. */
function ModuleDialog({ moduleId, onClose }: { moduleId: string; onClose: () => void }) {
  const session = useStudioSession();
  const toast = useToast();
  const latest = useLibraryModule(moduleId);
  const [version, setVersion] = useState<number | null>(null);
  const shown = useLibraryModule(moduleId, version);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"retire" | "restore" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const canEdit = atLeast(session.role, "editor");
  const versionId = useId();

  const setRetired = (retired: boolean) => {
    setBusy(true);
    setRefusal(null);
    studio
      .librarySetModule({ moduleId, retired })
      .then((res) => {
        refreshLibrary();
        toast.success(retired ? `“${res.module.title}” retired` : `“${res.module.title}” restored`, retired ? "Surveys that use it keep their copies." : "It is back in the library.");
        setConfirm(null);
      })
      .catch((e: unknown) => {
        setConfirm(null);
        setRefusal(e instanceof StudioCallError ? e.message : "That couldn’t be changed. Try again.");
      })
      .finally(() => setBusy(false));
  };

  const m = latest.status === "ready" ? latest.data.module : null;
  return (
    <Dialog title={m?.title ?? "Saved module"} onClose={onClose} width={720} footer={<Button onClick={onClose}>Close</Button>}>
      {latest.status === "loading" ? <Skeleton lines={6} label="Loading the module" /> : null}
      {latest.status === "error" ? <LoadError error={latest.error} retry={latest.retry} /> : null}
      {m && latest.status === "ready" ? (
        <>
          {refusal ? (
            <Notice tone="error" title="Not changed">
              {refusal}
            </Notice>
          ) : null}
          {editing ? (
            <ModuleEditForm module={m} onDone={() => setEditing(false)} />
          ) : (
            <section className="stl-about" aria-label="About this module">
              <dl className="stp-kv stp-kv-compact">
                <div>
                  <dt>ID</dt>
                  <dd>
                    <span className="stp-id">{m.moduleId}</span>
                    {m.retired ? (
                      <>
                        {" "}
                        <Badge tone="muted">Retired</Badge>
                      </>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{m.description || <span className="stp-muted">None</span>}</dd>
                </div>
                <div>
                  <dt>Tags</dt>
                  <dd>
                    {m.tags.length > 0 ? (
                      <span className="stl-tags">
                        {m.tags.map((t) => (
                          <span key={t} className="stl-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="stp-muted">None</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Created by</dt>
                  <dd>{m.createdByEmail}</dd>
                </div>
              </dl>
              {canEdit ? (
                <div className="stp-actions stl-about-actions">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                    Edit title, description and tags
                  </Button>
                  {m.retired ? (
                    <Button size="sm" variant="secondary" icon="restore" onClick={() => setConfirm("restore")}>
                      Restore
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" className="stn-danger-btn" icon="archive" onClick={() => setConfirm("retire")}>
                      Retire…
                    </Button>
                  )}
                </div>
              ) : null}
            </section>
          )}

          <section className="stl-result-part" aria-labelledby={`${versionId}-h`}>
            <h3 className="stl-h3" id={`${versionId}-h`}>
              Versions
            </h3>
            <div className="stp-table-wrap">
              <table className="stp-table" aria-labelledby={`${versionId}-h`}>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">What changed</th>
                    <th scope="col" className="stp-hide-narrow">
                      Saved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {latest.data.versions.map((v) => (
                    <tr key={v.version}>
                      <th scope="row">
                        v{v.version}
                        <span className="stp-srow-meta">{plural(v.questionCount, "question")}</span>
                      </th>
                      <td>
                        {v.note || <span className="stp-muted">No note</span>}
                        <span className="stp-srow-meta">
                          From <span className="stp-id">{v.source.surveyId}</span> in <span className="stp-id">{v.source.study}</span>
                        </span>
                      </td>
                      <td className="stp-hide-narrow">
                        {v.savedByEmail}
                        <span className="stp-srow-meta">{formatDateTime(toDate(v.savedAt))}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stl-result-part" aria-label="Questions">
            <div className="stl-questions-head">
              <h3 className="stl-h3">Questions</h3>
              <label className="st-field-label" htmlFor={versionId}>
                In version
              </label>
              <select
                id={versionId}
                className="st-select stl-inline-select"
                value={version ?? m.latestVersion}
                onChange={(e) => setVersion(Number(e.target.value) === m.latestVersion ? null : Number(e.target.value))}
              >
                {latest.data.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === m.latestVersion ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {shown.status === "loading" ? <Skeleton lines={4} label="Loading its questions" /> : null}
            {shown.status === "error" ? <LoadError error={shown.error} retry={shown.retry} /> : null}
            {shown.status === "ready" ? <FragmentQuestions fragment={shown.data.version.fragment} query="" /> : null}
          </section>
        </>
      ) : null}
      {confirm && m ? (
        <ConfirmDialog
          title={confirm === "retire" ? `Retire “${m.title}”?` : `Restore “${m.title}”?`}
          body={
            confirm === "retire" ? (
              <p className="stp-flush">
                It leaves the library, so it can&rsquo;t be added to more surveys. Surveys that already use it keep their copies, and
                nothing is deleted: it can be restored at any time.
              </p>
            ) : (
              <p className="stp-flush">It goes back into the library for every study space.</p>
            )
          }
          confirmLabel={confirm === "retire" ? "Retire module" : "Restore module"}
          destructive={confirm === "retire"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => setRetired(confirm === "retire")}
        />
      ) : null}
    </Dialog>
  );
}

function ModuleEditForm({ module: m, onDone }: { module: LibraryModuleSummary; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(m.title);
  const [description, setDescription] = useState(m.description);
  const [tags, setTags] = useState(m.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleError = title.trim() ? null : "Give the module a title.";

  const save = () => {
    if (titleError) return;
    setBusy(true);
    setError(null);
    studio
      .librarySetModule({ moduleId: m.moduleId, title: title.trim(), description: description.trim(), tags: parseTags(tags) })
      .then(() => {
        refreshLibrary();
        toast.success("Module updated", "Its title, description and tags are saved. Its questions and versions are unchanged.");
        onDone();
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The changes couldn’t be saved. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="stl-about"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label="Title" error={titleError}>
        {(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
      </Field>
      <Field label="Description" optional>
        {(p) => <textarea {...p} className="st-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label="Tags" optional hint="Separated by commas">
        {(p) => <input {...p} className="st-input" value={tags} onChange={(e) => setTags(e.target.value)} autoComplete="off" />}
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="stp-actions stl-about-actions">
        <Button size="sm" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" busy={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
