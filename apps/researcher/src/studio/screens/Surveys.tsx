import { useMemo, useState } from "react";
import { atLeast } from "@myself/studio";
import { studio, StudioCallError, useStudioSession, useSurveys, useVersions, type SurveyDoc } from "../data/index.js";
import { SURVEY_ID } from "../firebase.js";
import { formatDate, formatDateTime, formatRelative, plural, toDate, versionLabel } from "../format.js";
import { Link, navigate, type Route } from "../router.js";
import { LoadError } from "../shell/common.js";
import { PageHead, Shell } from "../shell/Shell.js";
import { Dialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { Button, EmptyState, Field, InfoTip, Notice, Skeleton, StatusDot, Tooltip } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";

/** Every survey in the study, what is live, and whether its draft has moved on. */
export function SurveysScreen() {
  const session = useStudioSession();
  const surveys = useSurveys();
  const isAdmin = atLeast(session.role, "admin");
  const [creating, setCreating] = useState(false);
  const hasLive = surveys.status === "ready" && surveys.data.some((s) => s.surveyId === SURVEY_ID);

  return (
    <Shell>
      <div className="stp-page">
        <PageHead
          title="Surveys"
          actions={
            isAdmin && surveys.status === "ready" && surveys.data.length > 0 ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                New survey
              </Button>
            ) : null
          }
        />
        {surveys.status === "loading" ? (
          <Skeleton lines={4} label="Loading surveys" />
        ) : surveys.status === "error" ? (
          <LoadError error={surveys.error} retry={surveys.retry} />
        ) : surveys.data.length === 0 ? (
          isAdmin ? (
            <FirstRun onNew={() => setCreating(true)} />
          ) : (
            <EmptyState icon="section" title="No surveys yet">
              <p>An admin sets the Studio up from the live survey. It appears here once they have.</p>
            </EmptyState>
          )
        ) : (
          <>
            {isAdmin && !hasLive ? <ImportLiveNotice /> : null}
            <div className="stp-table-wrap">
              <table className="stp-table stp-surveys" aria-label="Surveys">
                <thead>
                  <tr>
                    <th scope="col">Survey</th>
                    <th scope="col" className="stp-col-live">
                      Live
                    </th>
                    <th scope="col" className="stp-col-draft stp-hide-narrow">
                      Draft
                    </th>
                    <th scope="col" className="stp-col-when stp-hide-narrow">
                      Published
                    </th>
                    <th scope="col" className="stp-cell-action">
                      <span className="st-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {surveys.data.map((s) => (
                    <SurveyRow key={s.surveyId} survey={s} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {creating ? <NewSurveyDialog existing={surveys.status === "ready" ? surveys.data : []} onClose={() => setCreating(false)} /> : null}
    </Shell>
  );
}

function SurveyRow({ survey }: { survey: SurveyDoc }) {
  const active = survey.active;
  const publishedAt = toDate(active?.publishedAt);
  const editors = survey.draftEditors;
  const edited = editors.length > 0;
  const editedBy = edited ? `${editors[0]}${editors.length > 1 ? ` and ${plural(editors.length - 1, "other")}` : ""}` : null;
  return (
    <tr>
      <th scope="row" className="stp-cell-title">
        <Link to={{ name: "survey", surveyId: survey.surveyId, tab: "edit", q: null }} className="stp-srow-title stp-plain" title={survey.title}>
          {survey.title}
        </Link>
        <span className="stp-srow-meta">
          {/* The separator stays with the count, so a wrapped line never ends in "·". */}
          <span className="stp-id">{survey.surveyId}</span> <span className="stp-nowrap">· {plural(survey.versionCount, "version")}</span>
        </span>
      </th>
      <td>
        {active ? (
          <span className="stp-dotted">
            <StatusDot tone="accent" />
            <span className="stp-version-label">{versionLabel(active.version)}</span>
          </span>
        ) : (
          <span className="stp-dotted stp-muted">
            <StatusDot />
            Not published
          </span>
        )}
      </td>
      <td className="stp-hide-narrow">
        {edited ? (
          <span className="stp-truncate" title={`Edited since the last publish by ${editors.join(", ")}`}>
            Edited by {editedBy}
          </span>
        ) : active ? (
          <span className="stp-meta">Matches live</span>
        ) : (
          <span className="stp-meta">—</span>
        )}
      </td>
      <td className="stp-hide-narrow">
        {active ? (
          <span className="stp-muted" title={`${formatDateTime(publishedAt)}${active.publishedByEmail ? ` by ${active.publishedByEmail}` : ""}`}>
            {formatRelative(publishedAt)}
          </span>
        ) : (
          <span className="stp-meta">—</span>
        )}
      </td>
      <td className="stp-cell-action">
        <span className="stp-actions">
          <IconLink label={`Preview ${survey.title}`} tip="Preview" icon="eye" to={{ name: "survey", surveyId: survey.surveyId, tab: "preview", q: null }} />
          <IconLink label={`Versions of ${survey.title}`} tip="Versions" icon="history" to={{ name: "survey", surveyId: survey.surveyId, tab: "versions", q: null }} />
        </span>
      </td>
    </tr>
  );
}

/**
 * A link drawn as an icon button: a real link (new tab, copy address). Its
 * accessible name says which survey; the tooltip, which sits beside the row,
 * only needs the verb.
 */
function IconLink({ label, tip, icon, to }: { label: string; tip: string; icon: "eye" | "history"; to: Route }) {
  return (
    <Tooltip text={tip}>
      <Link to={to} className="st-iconbtn st-iconbtn-ghost st-iconbtn-md" aria-label={label}>
        <Icon name={icon} size={16} />
      </Link>
    </Tooltip>
  );
}

const IMPORT_HELP =
  "Brings the questionnaire participants are answering now, with its earlier versions, into the Studio, and starts a draft from the live one. What participants see doesn’t change and no responses are touched. Safe to run again: anything already here is left as it is.";

/** "Set up from the live survey" (docs/16 §6): an explicit, idempotent admin action. */
function useImportLive() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setError(null);
    studio
      .importLive({ surveyId: SURVEY_ID })
      .then((res) => {
        toast.success(
          res.imported.length > 0 ? "Live survey imported" : "Already imported",
          res.imported.length > 0
            ? `${plural(res.imported.length, "version")} · ${versionLabel(res.active)} is live`
            : `${versionLabel(res.active)} is live`,
        );
        navigate({ name: "survey", surveyId: res.surveyId, tab: "edit", q: null });
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The survey couldn’t be set up. Try again."))
      .finally(() => setBusy(false));
  };
  return { run, busy, error };
}

function FirstRun({ onNew }: { onNew: () => void }) {
  const importLive = useImportLive();
  return (
    <section className="stp-first" aria-labelledby="first-run-title">
      <Icon name="import" size={32} className="st-icon stp-first-icon" />
      <h2 id="first-run-title" className="stp-h2">
        Set up from the live survey
      </h2>
      <p>
        Import <span className="stp-id">{SURVEY_ID}</span> and its published versions.
        <InfoTip label="setting up from the live survey" text={IMPORT_HELP} />
      </p>
      {importLive.error ? <Notice tone="error">{importLive.error}</Notice> : null}
      <div className="stp-actions">
        <Button variant="primary" icon="import" busy={importLive.busy} onClick={importLive.run}>
          Set up from the live survey
        </Button>
        <Button variant="secondary" icon="plus" onClick={onNew}>
          New survey
        </Button>
      </div>
    </section>
  );
}

/** The same action, as one line above the list, once other surveys exist but the live one isn't set up. */
function ImportLiveNotice() {
  const importLive = useImportLive();
  return (
    <div className="stp-inline-notice">
      <Icon name="info" size={16} />
      <span>
        The live survey (<span className="stp-id">{SURVEY_ID}</span>) isn&rsquo;t in the Studio yet.{" "}
        <InfoTip label="setting up from the live survey" text={IMPORT_HELP} />
      </span>
      <Button size="sm" variant="secondary" icon="import" busy={importLive.busy} onClick={importLive.run}>
        Set up from the live survey
      </Button>
      {importLive.error ? <Notice tone="error">{importLive.error}</Notice> : null}
    </div>
  );
}

// ── New survey ────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** The release key `<id>_r<M>_<m>_<p>` must stay a slug of at most 64 characters, so the ID leaves room. */
const ID_MAX = 48;

export function surveyIdProblem(id: string, existing: readonly SurveyDoc[]): string | null {
  if (!id) return "Give the survey an ID.";
  if (id.length < 3) return "Use at least 3 characters.";
  if (id.length > ID_MAX) return `Use at most ${ID_MAX} characters.`;
  if (!ID_PATTERN.test(id)) return "Use lower-case letters, numbers and underscores, starting with a letter.";
  if (existing.some((s) => s.surveyId === id)) return "There’s already a survey with this ID.";
  return null;
}

function suggestId(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40);
}

function NewSurveyDialog({ existing, onClose }: { existing: SurveyDoc[]; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [start, setStart] = useState<"blank" | "version">("blank");
  const published = useMemo(() => existing.filter((s) => s.versionCount > 0), [existing]);
  const [fromSurvey, setFromSurvey] = useState(published[0]?.surveyId ?? "");
  const [fromVersion, setFromVersion] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = idTouched ? id : suggestId(title);
  const idError = surveyIdProblem(effectiveId, existing);
  const titleError = title.trim() ? null : "Give the survey a title.";
  const versionError = start === "version" && (!fromSurvey || !fromVersion) ? "Choose the version to start from." : null;
  const valid = !idError && !titleError && !versionError;

  const submit = () => {
    setSubmitted(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    studio
      .createSurvey({
        surveyId: effectiveId,
        title: title.trim(),
        from: start === "version" ? { surveyId: fromSurvey, version: fromVersion } : null,
      })
      .then((res) => {
        toast.success("Survey created", `“${title.trim()}” is ready to edit.`);
        onClose();
        navigate({ name: "survey", surveyId: res.surveyId, tab: "edit", q: null });
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The survey couldn’t be created. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      title="New survey"
      onClose={onClose}
      dismissable={!busy}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create survey
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
        <Field label="Title" hint="Seen by the research team, in exports and in the activity log." error={submitted ? titleError : null}>
          {(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
        </Field>
        <Field
          label="Survey ID"
          hint="Lower-case letters, numbers and underscores. It names every version (…_r1_0_0) and can’t be changed later."
          error={submitted || (idTouched && effectiveId.length > 0) || (effectiveId.length >= 3 && idError) ? idError : null}
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
        <fieldset className="stp-fieldset">
          <legend className="st-field-label">Start from</legend>
          <label className="stp-radio">
            <input type="radio" name="start" checked={start === "blank"} onChange={() => setStart("blank")} />
            <span>
              <strong>Blank</strong>
              <small>A start screen and a thank-you screen, ready for questions.</small>
            </span>
          </label>
          <label className={`stp-radio${published.length === 0 ? " disabled" : ""}`}>
            <input
              type="radio"
              name="start"
              checked={start === "version"}
              disabled={published.length === 0}
              onChange={() => setStart("version")}
            />
            <span>
              <strong>A published version of another survey</strong>
              <small>
                {published.length === 0
                  ? "No survey has published a version yet."
                  : "Question IDs stay as they are, so data can be compared."}
              </small>
            </span>
          </label>
          {start === "version" ? (
            <div className="stp-indent">
              <Field label="Survey">
                {(p) => (
                  <select
                    {...p}
                    className="st-select"
                    value={fromSurvey}
                    onChange={(e) => {
                      setFromSurvey(e.target.value);
                      setFromVersion("");
                    }}
                  >
                    {published.map((s) => (
                      <option key={s.surveyId} value={s.surveyId}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {fromSurvey ? <VersionSelect surveyId={fromSurvey} value={fromVersion} onChange={setFromVersion} error={submitted ? versionError : null} /> : null}
            </div>
          ) : null}
        </fieldset>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function VersionSelect({
  surveyId,
  value,
  onChange,
  error,
}: {
  surveyId: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const versions = useVersions(surveyId);
  if (versions.status === "loading") return <Skeleton lines={1} label="Loading versions" />;
  if (versions.status === "error") return <LoadError error={versions.error} retry={versions.retry} />;
  return (
    <Field label="Version" error={error}>
      {(p) => (
        <select {...p} className="st-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a version…</option>
          {versions.data.map((v) => (
            <option key={v.version} value={v.version}>
              {versionLabel(v.version)} — published {formatDate(toDate(v.publishedAt))}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
