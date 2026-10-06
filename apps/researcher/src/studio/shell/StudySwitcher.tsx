import { useState } from "react";
import { STUDY_ID_PATTERN } from "@myself/schema";
import type { StudyStatus, StudySummary } from "@myself/studio";
import { studio, StudioCallError, useStudioSession } from "../data/index.js";
import { DEFAULT_STUDY, navigate, useStudy } from "../router.js";
import { Dialog } from "../ui/dialog.js";
import { Button, Field, MenuButton, Notice, type MenuItem } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";

/**
 * Which study space the Studio is in, and moving between them (D-56, docs/16
 * §11.4–§11.5).
 *
 * The list is the server's (`studioSession`): only studies where this person
 * has a role, read from each study's own list, so it never offers a study
 * whose every read the rules would refuse. An owner sees every study, and is
 * the only one offered "New study space" and a study's settings — closing,
 * reopening, renaming — because those decide what the project runs, not how
 * one study's survey reads.
 *
 * Shown only when there is more than one study to be in, or the person is an
 * owner, or the Studio is in a study other than the default: someone who only
 * ever works on `ybm` sees the header they always saw.
 */
export function StudySwitcher() {
  const session = useStudioSession();
  const study = useStudy();
  const [dialog, setDialog] = useState<"new" | "settings" | null>(null);
  const here = session.studies.find((s) => s.study === study) ?? null;
  const shown = session.status === "ready" && (session.studies.length > 1 || session.owner || study !== DEFAULT_STUDY);
  if (!shown) return null;

  const items: MenuItem[] = session.studies.map((s) => ({
    label: s.title,
    icon: s.study === study ? "check" : "folder",
    hint: s.status === "closed" ? `${s.study} · closed` : s.study,
    onSelect: () => void navigate({ name: "surveys" }, { study: s.study }),
  }));
  if (session.owner) {
    items.push(
      { label: "New study space…", icon: "plus", onSelect: () => setDialog("new") },
      { label: "This study space’s settings…", icon: "settings", onSelect: () => setDialog("settings") },
    );
  }

  return (
    <>
      <span className="stp-crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="stp-study-switch">
        <MenuButton
          label={`Study space: ${here?.title ?? study}. Change`}
          icon="folder"
          align="start"
          items={items}
          buttonLabel={
            <>
              {here?.title ?? study}
              {here?.status === "closed" ? <span className="stp-study-closed">Closed</span> : null}
            </>
          }
        />
      </span>
      {dialog === "new" ? <NewStudyDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "settings" ? <StudySettingsDialog study={study} current={here} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** A study id from a title: what the dialog suggests until the id is typed. */
export function suggestStudyId(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

/** Why an id can't be a new study space's, in words; null when it can. */
export function studyIdProblem(id: string, taken: readonly string[]): string | null {
  if (!id) return "Give the study space an ID.";
  if (id.length < 2) return "Use at least 2 characters.";
  if (id.length > 40) return "Use at most 40 characters.";
  if (!STUDY_ID_PATTERN.test(id)) return "Use lower-case letters, numbers and underscores, starting with a letter.";
  if (taken.includes(id)) return "There’s already a study space with this ID.";
  return null;
}

function NewStudyDialog({ onClose }: { onClose: () => void }) {
  const session = useStudioSession();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveId = idTouched ? id : suggestStudyId(title);
  const idError = studyIdProblem(effectiveId, session.studies.map((s) => s.study));
  const titleError = title.trim() ? null : "Give the study space a title.";

  const submit = () => {
    setSubmitted(true);
    if (idError || titleError) return;
    setBusy(true);
    setError(null);
    studio
      .createStudy({ study: effectiveId, title: title.trim() })
      .then((res) => {
        toast.success("Study space created", `“${title.trim()}” is open, and you are its admin.`);
        onClose();
        navigate({ name: "surveys" }, { study: res.study });
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The study space couldn’t be created. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      title="New study space"
      onClose={onClose}
      dismissable={!busy}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create study space
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="stp-flush">
          A study space has its own surveys and participant links, its own list of who has access, and its own data:
          devices, sittings and exports are kept apart from every other study&rsquo;s. You will be its first admin.
        </p>
        <Field label="Title" hint="Seen by the research team. Anyone who knows the ID can see it, so write it for the public." error={submitted ? titleError : null}>
          {(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
        </Field>
        <Field
          label="Study ID"
          hint="Lower-case letters, numbers and underscores, 2 to 40 characters. It is in every participant link and every path the study's data is filed under, and can't be changed or reused."
          error={submitted || (idTouched && effectiveId.length > 0) ? idError : null}
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
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function StudySettingsDialog({ study, current, onClose }: { study: string; current: StudySummary | null; onClose: () => void }) {
  const session = useStudioSession();
  const toast = useToast();
  const [title, setTitle] = useState(current?.title ?? study);
  const [status, setStatus] = useState<StudyStatus>(current?.status ?? "open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = title.trim() !== (current?.title ?? study) || status !== (current?.status ?? "open");

  const submit = () => {
    if (!title.trim()) {
      setError("Give the study space a title.");
      return;
    }
    setBusy(true);
    setError(null);
    studio
      .setStudy({ study, title: title.trim(), status })
      .then((res) => {
        toast.success(res.status === "closed" ? "Study space closed" : "Study space saved", res.title);
        onClose();
        void session.refresh();
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The change couldn’t be saved. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      title="Study space settings"
      description={<code>{study}</code>}
      onClose={onClose}
      dismissable={!busy}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={status === "closed" && current?.status !== "closed" ? "danger" : "primary"} busy={busy} disabled={!changed} onClick={submit}>
            {status === "closed" && current?.status !== "closed" ? "Close the study space" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Title">{(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}</Field>
      <fieldset className="stp-fieldset">
        <legend className="st-field-label">Status</legend>
        <label className="stp-radio">
          <input type="radio" name="study-status" checked={status === "open"} onChange={() => setStatus("open")} />
          <span>
            <strong>Open</strong>
            <small>iPads can be set to its surveys, and start sittings in it.</small>
          </span>
        </label>
        <label className="stp-radio">
          <input type="radio" name="study-status" checked={status === "closed"} onChange={() => setStatus("closed")} />
          <span>
            <strong>Closed</strong>
            <small>
              No new iPad can join it, an iPad that sees it is closed starts no new sitting, and MyStory makes no model calls
              for it. Sittings already on iPads it knows are still accepted, nothing is deleted, and it can be reopened.
            </small>
          </span>
        </label>
      </fieldset>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}
