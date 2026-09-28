import { useMemo, useState } from "react";
import { atLeast } from "@myself/studio";
import { studio, StudioCallError, useStudioSession, useSurveys, useVersions, type SurveyDoc } from "../data/index.js";
import { SURVEY_ID } from "../firebase.js";
import { formatDate, formatRelative, plural, toDate, versionLabel } from "../format.js";
import { Link, navigate } from "../router.js";
import { LoadError } from "../shell/common.js";
import { PageHead, Shell } from "../shell/Shell.js";
import { Dialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { Badge, Button, EmptyState, Field, Notice, Skeleton } from "../ui/kit.js";
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
          lede="Each survey has one working draft, shared by everyone editing it, and the versions published from it."
          actions={
            isAdmin && surveys.status === "ready" && surveys.data.length > 0 ? (
              <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
                New survey
              </Button>
            ) : null
          }
        />
        {surveys.status === "loading" ? (
          <div className="stp-card">
            <Skeleton lines={4} label="Loading surveys" />
          </div>
        ) : surveys.status === "error" ? (
          <LoadError error={surveys.error} retry={surveys.retry} />
        ) : surveys.data.length === 0 ? (
          isAdmin ? (
            <FirstRun onNew={() => setCreating(true)} />
          ) : (
            <EmptyState icon="section" title="No surveys have been set up yet">
              <p>
                An admin sets the Studio up from the survey participants are answering now. Once they have, it appears
                here for everyone on the Studio list.
              </p>
            </EmptyState>
          )
        ) : (
          <>
            {isAdmin && !hasLive ? (
              <div className="stp-gap">
                <ImportLiveCard compact />
              </div>
            ) : null}
            <ul className="stp-survey-list" aria-label="Surveys">
              {surveys.data.map((s) => (
                <SurveyRow key={s.surveyId} survey={s} />
              ))}
            </ul>
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
  const edited = survey.draftEditors.length > 0;
  const headingId = `survey-${survey.surveyId}`;
  return (
    <li className="stp-card stp-survey" aria-labelledby={headingId}>
      <div className="stp-survey-main">
        <h2 id={headingId} className="stp-survey-title">
          <Link to={{ name: "survey", surveyId: survey.surveyId, tab: "edit", q: null }}>{survey.title}</Link>
        </h2>
        <p className="stp-survey-id">
          <code>{survey.surveyId}</code>
        </p>
        <div className="stp-badges">
          {active ? (
            <Badge tone="accent" icon="check" title={`Published ${formatDate(publishedAt)}`}>
              Live: {versionLabel(active.version)}
            </Badge>
          ) : (
            <Badge tone="muted">Not published yet</Badge>
          )}
          {edited ? (
            <Badge tone="warn" icon="flag">
              Draft has unpublished changes
            </Badge>
          ) : active ? (
            <Badge>Draft matches the live version</Badge>
          ) : null}
        </div>
        <p className="stp-survey-meta">
          {active ? (
            <>
              {versionLabel(active.version)} published {formatRelative(publishedAt)}
              {active.publishedByEmail ? ` by ${active.publishedByEmail}` : ""}
            </>
          ) : (
            "Nothing published from this survey yet"
          )}
          {edited ? (
            <>
              {" · "}Edited since by {survey.draftEditors.slice(0, 3).join(", ")}
              {survey.draftEditors.length > 3 ? ` and ${plural(survey.draftEditors.length - 3, "other")}` : ""}
            </>
          ) : null}
          {" · "}
          {plural(survey.versionCount, "version")}
        </p>
      </div>
      <div className="stp-survey-actions">
        <Link to={{ name: "survey", surveyId: survey.surveyId, tab: "edit", q: null }} className="st-btn st-btn-primary st-btn-sm">
          <span>Open</span>
        </Link>
        <Link to={{ name: "survey", surveyId: survey.surveyId, tab: "preview", q: null }} className="st-btn st-btn-ghost st-btn-sm">
          <Icon name="eye" size={16} />
          <span>Preview</span>
        </Link>
        <Link to={{ name: "survey", surveyId: survey.surveyId, tab: "versions", q: null }} className="st-btn st-btn-ghost st-btn-sm">
          <Icon name="history" size={16} />
          <span>Versions</span>
        </Link>
      </div>
    </li>
  );
}

function FirstRun({ onNew }: { onNew: () => void }) {
  return (
    <div className="stp-first-run">
      <ImportLiveCard />
      <div className="stp-card stp-first-alt">
        <h2 className="stp-h2">Or start a different survey</h2>
        <p>A new survey starts blank, or from a published version of another survey. It has its own versions and its own link for participants.</p>
        <Button variant="secondary" icon="plus" onClick={onNew}>
          New survey
        </Button>
      </div>
    </div>
  );
}

/** "Set up from the live survey" (docs/16 §6): an explicit, idempotent admin action. */
function ImportLiveCard({ compact = false }: { compact?: boolean }) {
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
          "The live survey is set up",
          res.imported.length > 0
            ? `Brought in ${res.imported.map(versionLabel).join(", ")}. ${versionLabel(res.active)} is live, and the draft starts from it.`
            : `Everything was already here. ${versionLabel(res.active)} is live.`,
        );
        navigate({ name: "survey", surveyId: res.surveyId, tab: "edit", q: null });
      })
      .catch((e: unknown) => setError(e instanceof StudioCallError ? e.message : "The survey couldn’t be set up. Try again."))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`stp-card stp-import${compact ? " compact" : ""}`}>
      <div>
        <h2 className="stp-h2">Set up from the live survey</h2>
        <p>
          Brings the questionnaire participants are answering now (<code>{SURVEY_ID}</code>) and its earlier versions
          into the Studio, and starts a draft from the live one. What participants see doesn&rsquo;t change, and no
          responses are touched. Safe to run again: anything already here is left as it is.
        </p>
        {error ? (
          <div className="stp-gap-top">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
      </div>
      <div className="stp-import-action">
        <Button variant="accent" icon="restore" busy={busy} onClick={run}>
          Set up from the live survey
        </Button>
      </div>
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
      width={560}
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
        <Field label="Title" hint="For the research team: it appears in the Studio, exports and the audit trail." error={submitted ? titleError : null}>
          {(p) => <input {...p} className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
        </Field>
        <Field
          label="Survey ID"
          hint="Lower-case letters, numbers and underscores. It names every version (for example …_r1_0_0) and can’t be changed later."
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
              <strong>A blank survey</strong>
              <small>A welcome message and a thank-you screen, ready for questions.</small>
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
                  : "A copy of its questions and screens. Question IDs stay as they are, so data can be compared."}
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
