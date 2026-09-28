import { useEffect, useId, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { diffDrafts, outline, validateDraft, type Issue, type ValidationContext } from "@myself/studio";
import { StudioCallError, studio, type PublishedContext } from "../data/index.js";
import { versionLabel } from "../format.js";
import { Link } from "../router.js";
import { ChangeList, changeHeadline } from "../shell/common.js";
import { Dialog } from "../ui/dialog.js";
import { Icon } from "../ui/icons.js";
import { Button, Notice, Spinner } from "../ui/kit.js";
import { useEditor, type EditorContextValue } from "./context.js";
import { PUBLIC_SURVEY_URL } from "./publish/links.js";
import {
  blocker,
  chosenVersion,
  classifyPublishError,
  failureTitle,
  inFlight,
  initialPublishState,
  NOTE_MAX,
  NOTE_MIN,
  publishReducer,
  STEP_TITLES,
  STEPS,
  warningsOf,
  type FormStep,
  type PrepareOutcome,
  type PublishState,
} from "./publish/machine.js";
import { versionOptions } from "./publish/version.js";
import { groupIssues, selectionFor } from "./validation/select.js";
import "./publish.css";

/**
 * Publishing a new version, step by step.
 *
 * The dialog's behaviour is the state machine in publish/machine.ts; this file
 * draws each state and runs its side effects — saving, publishing, and reading
 * the live pointer back — each exactly once per attempt. It cannot be closed
 * while a publish is in flight, says plainly that nothing was published when
 * the server refuses (the server's publish is all-or-nothing), and says a
 * version is live only once the public pointer has been seen naming it.
 */
export function PublishDialog() {
  const ctx = useEditor();
  const open = ctx.publishOpen && ctx.canPublish;
  useEffect(() => {
    // Only publishers ever get here; anything else asking is closed again.
    if (ctx.publishOpen && !ctx.canPublish) ctx.setPublishOpen(false);
  }, [ctx]);
  return open ? <PublishFlow /> : null;
}

// Each `confirmLive` already reads the pointer up to three times over ~2.5 s;
// three of those, two seconds apart, is about ten seconds in all.
const CONFIRM_ATTEMPTS = 3;
const CONFIRM_GAP_MS = 2000;

function validationContext(published: PublishedContext | null): ValidationContext {
  if (!published) return {};
  return {
    reserved: published.reserved,
    ...(published.baseline ? { baseline: published.baseline } : {}),
    publishedScaleCodes: published.publishedScaleCodes,
  };
}

/** How the save before publishing went, and — if it went through — everything the dialog decides with. */
function prepare(c: EditorContextValue): PrepareOutcome {
  const save = c.editor.save;
  if (save.kind === "conflict") {
    return {
      kind: "conflict",
      message:
        "Someone else saved this draft while you were editing, so your latest changes aren’t saved. Choose which version to keep (the message at the top of the page), then publish.",
    };
  }
  if (save.kind === "offline") {
    return { kind: "offline", message: "You’re offline, so your latest changes can’t be saved — and only saved changes can be published. Try again once you’re back online." };
  }
  if (save.kind === "error") return { kind: "error", message: `Your latest changes couldn’t be saved: ${save.message}` };
  if (save.kind !== "saved" || c.editor.hasUnsavedChanges) {
    return { kind: "error", message: "Your latest changes haven’t been saved yet, so they can’t be published. Try again in a moment." };
  }
  if (c.publishedStatus === "error" || !c.published) {
    return {
      kind: "context",
      message: "The versions already published couldn’t be loaded, so the changes can’t be checked against the live one. Try again in a moment.",
    };
  }
  return {
    kind: "ready",
    inputs: {
      revision: c.editor.revision,
      // Validation already ran on exactly this draft if it is fresh; otherwise run it now.
      issues: c.issuesFresh ? c.issues : validateDraft(c.draft, validationContext(c.published)),
      summary: diffDrafts(c.published.baseline ?? null, c.draft),
      latest: c.published.latestVersion ?? c.survey?.latestVersion ?? null,
      liveVersion: c.survey?.active?.version ?? c.published.active?.version ?? null,
    },
  };
}

function PublishFlow() {
  const ctx = useEditor();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [s, dispatch] = useReducer(publishReducer, undefined, initialPublishState);
  const [savedRun, setSavedRun] = useState<number | null>(null);
  const close = () => ctx.setPublishOpen(false);

  // ── 1. Save the latest changes ───────────────────────────────────────────
  useEffect(() => {
    let live = true;
    void ctxRef.current.editor.saveNow().finally(() => {
      if (live) setSavedRun(s.run);
    });
    return () => {
      live = false;
    };
  }, [s.run]);

  // ── 2. Once the save has settled, check ─────────────────────────────────
  useEffect(() => {
    if (s.step !== "preparing" || savedRun !== s.run) return;
    // The save engine's state catches up a render after its promise settles.
    if (ctx.editor.save.kind === "saving" || ctx.publishedStatus === "loading") return;
    dispatch({ type: "prepared", outcome: prepare(ctx) });
  }, [s.step, s.run, savedRun, ctx]);

  // ── 3. Publish, once per attempt ─────────────────────────────────────────
  const started = useRef(0);
  useEffect(() => {
    if (s.step !== "publishing" || started.current === s.attempt || !s.inputs) return;
    started.current = s.attempt;
    const version = chosenVersion(s);
    if (!version) return;
    studio
      .publish({ surveyId: ctxRef.current.surveyId, expectedRevision: s.inputs.revision, version, releaseNote: s.note.trim() })
      .then((res) => dispatch({ type: "published", result: { version: res.version, hash: res.hash, alreadyPublished: res.alreadyPublished } }))
      .catch((error: unknown) => {
        const e = error instanceof StudioCallError ? error : null;
        dispatch({
          type: "failed",
          failure: classifyPublishError({
            code: e?.code ?? "unknown",
            message: e?.message ?? (error instanceof Error ? error.message : String(error)),
            details: e?.details ?? null,
          }),
        });
      });
  }, [s]);

  // ── 4. Read the live pointer back ────────────────────────────────────────
  useEffect(() => {
    if (s.step !== "confirming" || !s.published) return;
    const { hash } = s.published;
    let live = true;
    void (async () => {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS && live; attempt++) {
        try {
          if (await studio.confirmLive(ctxRef.current.surveyId, hash)) {
            if (live) dispatch({ type: "confirmed", live: true });
            return;
          }
        } catch {
          // Reading it back failed this time; the publish itself went through.
        }
        if (attempt < CONFIRM_ATTEMPTS - 1) await new Promise((r) => window.setTimeout(r, CONFIRM_GAP_MS));
      }
      if (live) dispatch({ type: "confirmed", live: false });
    })();
    return () => {
      live = false;
    };
  }, [s.step, s.published]);

  // A new step's heading takes focus, so a screen reader hears where it is now.
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [s.step]);

  const goTo = (issue: Issue) => {
    close();
    const field = issue.location.field;
    ctx.select(selectionFor(issue, outline(ctx.draft)), field ? { field } : undefined);
  };

  // The step's own heading says where things are; the title only frames it.
  const title = s.step === "live" ? "Published" : "Publish a new version";

  const body = <StepBody s={s} dispatch={dispatch} headingRef={heading} goTo={goTo} />;
  return (
    <Dialog
      title={title}
      onClose={close}
      dismissable={!inFlight(s)}
      width={680}
      initialFocus=".sto-pub-heading"
      footer={<Footer s={s} dispatch={dispatch} close={close} />}
    >
      {isFormStep(s.step) ? <Stepper current={s.step} hasChecks={warningsOf(s).length > 0} /> : null}
      {body}
    </Dialog>
  );
}

function isFormStep(step: PublishState["step"]): step is FormStep {
  return (STEPS as readonly string[]).includes(step);
}

function Stepper({ current, hasChecks }: { current: FormStep; hasChecks: boolean }) {
  const steps = STEPS.filter((step) => step !== "checks" || hasChecks);
  const at = steps.indexOf(current);
  return (
    <ol className="sto-steps" aria-label={`Step ${at + 1} of ${steps.length}`}>
      {steps.map((step, i) => (
        <li key={step} className={i < at ? "done" : i === at ? "current" : ""} aria-current={i === at ? "step" : undefined}>
          <span className="sto-step-mark" aria-hidden="true">
            {i < at ? <Icon name="check" size={12} /> : i + 1}
          </span>
          {STEP_TITLES[step]}
        </li>
      ))}
    </ol>
  );
}

type Dispatch = (e: Parameters<typeof publishReducer>[1]) => void;

function Heading({ children, headingRef }: { children: ReactNode; headingRef: RefObject<HTMLHeadingElement> }) {
  return (
    <h3 className="sto-pub-heading" ref={headingRef} tabIndex={-1}>
      {children}
    </h3>
  );
}

function IssuesToFix({ issues, goTo, severity }: { issues: Issue[]; goTo: (i: Issue) => void; severity: "error" | "warning" }) {
  const ctx = useEditor();
  const groups = groupIssues(issues, outline(ctx.draft));
  const list = severity === "error" ? groups.errors : groups.warnings;
  return (
    <ul className="sto-pub-issues">
      {list.flatMap((g) =>
        g.issues.map((issue, i) => (
          <li key={`${g.id}:${i}`}>
            <Icon name={severity === "error" ? "error" : "warning"} size={16} />
            <span>
              <strong>{g.label}</strong>
              {g.context ? <span className="stp-muted"> in {g.context}</span> : null}
              <br />
              {issue.message}
            </span>
            <Button size="sm" variant="secondary" onClick={() => goTo(issue)} aria-label={`Go to ${g.label}`}>
              Go to
            </Button>
          </li>
        )),
      )}
    </ul>
  );
}

function StepBody({
  s,
  dispatch,
  headingRef,
  goTo,
}: {
  s: PublishState;
  dispatch: Dispatch;
  headingRef: RefObject<HTMLHeadingElement>;
  goTo: (i: Issue) => void;
}) {
  const noteId = useId();
  const ctx = useEditor();
  const version = chosenVersion(s);
  const v = version ? versionLabel(version) : "";
  const since = s.inputs?.liveVersion ? ` since ${versionLabel(s.inputs.liveVersion)}` : "";
  const problem = s.attempted ? blocker(s) : null;
  const surveyId = ctx.surveyId;

  switch (s.step) {
    case "preparing":
      return (
        <div className="sto-pub-busy">
          <Heading headingRef={headingRef}>Saving your latest changes…</Heading>
          <p className="stp-flush">
            <Spinner /> Then the draft is checked one last time.
          </p>
        </div>
      );

    case "stopped": {
      const stop = s.stop!;
      if (stop.kind === "save") {
        return (
          <>
            <Heading headingRef={headingRef}>Your latest changes aren&rsquo;t saved</Heading>
            <Notice tone={stop.reason === "context" ? "warn" : "error"}>{stop.message}</Notice>
            <p>Nothing has been published.</p>
          </>
        );
      }
      if (stop.kind === "errors") {
        return (
          <>
            <Heading headingRef={headingRef}>
              {stop.errors.length === 1 ? "1 error must be fixed first" : `${stop.errors.length} errors must be fixed first`}
            </Heading>
            <p className="stp-flush">
              Errors stop a version being published, because participants would meet a survey that doesn&rsquo;t work. Go to
              each one and fix it, then publish again.
            </p>
            <IssuesToFix issues={stop.errors} goTo={goTo} severity="error" />
          </>
        );
      }
      return (
        <>
          <Heading headingRef={headingRef}>The draft matches the live version</Heading>
          <p className="stp-flush">
            Nothing has changed{stop.liveVersion ? ` since ${versionLabel(stop.liveVersion)}` : ""} — there&rsquo;s nothing to publish.
            The draft is exactly what participants see now.
          </p>
        </>
      );
    }

    case "checks": {
      const warnings = warningsOf(s);
      return (
        <>
          <Heading headingRef={headingRef}>Nothing stops this being published</Heading>
          <p className="stp-flush">
            {warnings.length === 1 ? "One warning is" : `${warnings.length} warnings are`} worth a look first. They don&rsquo;t block
            publishing.
          </p>
          <IssuesToFix issues={warnings} goTo={goTo} severity="warning" />
          <label className={`sto-pub-check${problem ? " has-error" : ""}`}>
            <input type="checkbox" checked={s.reviewed} onChange={(e) => dispatch({ type: "review", reviewed: e.target.checked })} aria-describedby={problem ? `${noteId}-review` : undefined} />
            <span>I&rsquo;ve reviewed these warnings</span>
          </label>
          {problem ? (
            <p id={`${noteId}-review`} className="sto-pub-problem">
              <Icon name="error" size={14} /> {problem}
            </p>
          ) : null}
        </>
      );
    }

    case "changes": {
      const summary = s.inputs!.summary;
      const breaking = summary.entries.filter((e) => e.breaking).length;
      return (
        <>
          <Heading headingRef={headingRef}>What changes{since}</Heading>
          {warningsOf(s).length === 0 ? (
            <p className="sto-pub-ok">
              <Icon name="check" size={16} /> All checks passed.
            </p>
          ) : null}
          <p className="stp-flush">
            <strong>{changeHeadline(summary)}</strong>
          </p>
          {breaking > 0 ? (
            <Notice tone="warn" title={breaking === 1 ? "1 change is breaking" : `${breaking} changes are breaking`}>
              A breaking change changes how answers are coded — consider a new question instead, so answers collected before and
              after it don&rsquo;t share a column but mean different things.
            </Notice>
          ) : null}
          <div className="sto-pub-changes">
            <ChangeList summary={summary} />
          </div>
        </>
      );
    }

    case "version": {
      const options = versionOptions(s.latest, s.required);
      return (
        <>
          <Heading headingRef={headingRef}>Choose the version number</Heading>
          <p className="stp-flush">
            {s.latest ? `The latest version is ${versionLabel(s.latest)}. ` : ""}The changes decide the smallest step allowed; you can
            choose a bigger one, never a smaller one.
          </p>
          <fieldset className="stp-fieldset sto-pub-versions">
            <legend className="st-sr">Version number</legend>
            {options.map((o) => (
              <label key={o.bump} className={`stp-radio${o.allowed ? "" : " disabled"}`}>
                <input
                  type="radio"
                  name="sto-version"
                  value={o.bump}
                  checked={s.bump === o.bump}
                  disabled={!o.allowed}
                  onChange={() => dispatch({ type: "choose", bump: o.bump })}
                />
                <span>
                  <strong>
                    {o.title} — {versionLabel(o.version)}
                    {o.required && s.latest ? <em className="sto-pub-rec"> · what these changes need</em> : null}
                  </strong>
                  <small>{o.meaning}</small>
                  {o.reason ? (
                    <small className="sto-pub-why">
                      <Icon name="lock" size={12} /> Not allowed: {o.reason}
                    </small>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          {problem ? (
            <p className="sto-pub-problem">
              <Icon name="error" size={14} /> {problem}
            </p>
          ) : null}
        </>
      );
    }

    case "note": {
      const length = s.note.trim().length;
      return (
        <>
          <Heading headingRef={headingRef}>Write the release note</Heading>
          <div className={`st-field${problem ? " st-field-error" : ""}`}>
            <label htmlFor={noteId} className="st-field-label">
              Release note for {v}
            </label>
            <textarea
              id={noteId}
              className="st-input sto-pub-note"
              rows={5}
              value={s.note}
              maxLength={NOTE_MAX + 200}
              onChange={(e) => dispatch({ type: "note", text: e.target.value })}
              aria-describedby={`${noteId}-hint${problem ? ` ${noteId}-err` : ""}`}
              aria-invalid={problem ? true : undefined}
            />
            <div id={`${noteId}-hint`} className="st-field-hint">
              What changed and why, for the version history — anyone reading the data later looks here to understand it. At least{" "}
              {NOTE_MIN} characters. <span className="sto-pub-count">{length.toLocaleString("en-GB")} / {NOTE_MAX.toLocaleString("en-GB")}</span>
            </div>
            {problem ? (
              <div id={`${noteId}-err`} className="st-field-msg st-field-msg-error">
                <Icon name="error" size={14} /> {problem}
              </div>
            ) : null}
          </div>
        </>
      );
    }

    case "confirm":
      return (
        <>
          <Heading headingRef={headingRef}>Publish {v}?</Heading>
          <dl className="sto-pub-summary">
            <div>
              <dt>Version</dt>
              <dd>{v}</dd>
            </div>
            <div>
              <dt>Changes</dt>
              <dd>
                {changeHeadline(s.inputs!.summary)}
                {s.inputs?.liveVersion ? <span className="stp-muted"> Compared with {versionLabel(s.inputs.liveVersion)}.</span> : null}
              </dd>
            </div>
            <div>
              <dt>Release note</dt>
              <dd className="sto-pub-quote">{s.note.trim()}</dd>
            </div>
          </dl>
          <p>
            Publishing {v} makes it the live version at the public survey link. Participants who start after this see it; anyone
            mid-way through carries on with the version they started. Earlier versions and all responses are kept.
          </p>
        </>
      );

    case "publishing":
      return (
        <div className="sto-pub-busy">
          <Heading headingRef={headingRef}>Publishing {v}…</Heading>
          <p className="stp-flush">
            <Spinner /> This takes a few seconds. Keep this window open.
          </p>
        </div>
      );

    case "confirming":
      return (
        <div className="sto-pub-busy">
          <Heading headingRef={headingRef}>Checking the live link…</Heading>
          <p className="stp-flush">
            <Spinner /> {v} has been published. Waiting to see participants&rsquo; link point at it.
          </p>
        </div>
      );

    case "live": {
      const p = s.published!;
      return (
        <>
          <Heading headingRef={headingRef}>
            <Icon name="check" size={20} /> {versionLabel(p.version)} is live
          </Heading>
          <p className="stp-flush">
            Participants who start from now see {versionLabel(p.version)}. Anyone mid-way through carries on with the version they
            started.
          </p>
          {p.alreadyPublished ? <p>This version had already been published from this draft, so nothing new was written.</p> : null}
          <p className="sto-pub-links">
            <Link to={{ name: "survey", surveyId, tab: "versions", q: null }} className="st-btn st-btn-secondary st-btn-sm">
              <Icon name="history" size={16} />
              <span>See it in Versions</span>
            </Link>
            <a href={PUBLIC_SURVEY_URL} target="_blank" rel="noopener noreferrer" className="st-btn st-btn-secondary st-btn-sm">
              <Icon name="external" size={16} />
              <span>Open the survey link</span>
              <span className="st-sr"> (opens in a new tab)</span>
            </a>
          </p>
        </>
      );
    }

    case "unconfirmed": {
      const p = s.published;
      return (
        <>
          <Heading headingRef={headingRef}>Published, but not confirmed yet</Heading>
          <Notice tone="warn">
            Published, but the live link hasn&rsquo;t confirmed yet — check Versions in a minute.
            {p ? ` ${versionLabel(p.version)} was accepted by the server; participants' devices pick it up at their next start screen.` : ""}
          </Notice>
          <p className="sto-pub-links">
            <Link to={{ name: "survey", surveyId, tab: "versions", q: null }} className="st-btn st-btn-secondary st-btn-sm">
              <Icon name="history" size={16} />
              <span>Open Versions</span>
            </Link>
          </p>
        </>
      );
    }

    case "failed": {
      const f = s.failure!;
      return (
        <>
          <Heading headingRef={headingRef}>{failureTitle(f)}</Heading>
          <Notice tone={f.kind === "uncertain" ? "warn" : "error"}>
            <FailureDetail s={s} />
          </Notice>
          {f.kind === "invalid" && f.issues.length > 0 ? <IssuesToFix issues={f.issues.filter((i) => i.severity === "error")} goTo={goTo} severity="error" /> : null}
          {f.kind === "invalid" && f.gate.length > 0 ? (
            <>
              <p>The publish check also said:</p>
              <ul className="sto-pub-gate">
                {f.gate.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      );
    }
  }
}

function FailureDetail({ s }: { s: PublishState }) {
  const f = s.failure!;
  const v = versionLabel(chosenVersion(s));
  switch (f.kind) {
    case "conflict":
      return <>Someone saved the draft after you started, so what you checked isn&rsquo;t what&rsquo;s saved now. Review their changes and try again.</>;
    case "invalid":
      return <>The server checked the draft again and found problems that stop it being published. Fix them, then publish again.</>;
    case "version_taken":
      return <>Someone published {versionLabel(f.version)} a moment ago. Choose the next version number and publish again.</>;
    case "bump_too_small":
      return <>These changes need at least {versionLabel(f.minimumVersion)}. Choose a version at least that high.</>;
    case "forbidden":
      return <>Your account can&rsquo;t publish any more — it may have been changed since you signed in. Ask an admin.</>;
    case "offline":
      return <>Check your connection, then try again. Trying again is safe: a version is never published twice.</>;
    case "uncertain":
      return (
        <>
          It may still have published {v}. Check Versions before doing anything else. Trying again is safe: if it went through, the
          same version is simply reported back rather than published twice.
        </>
      );
    case "other":
      return <>{f.message} Try again, and if it keeps happening, tell the study&rsquo;s technical lead.</>;
  }
}

function Footer({ s, dispatch, close }: { s: PublishState; dispatch: Dispatch; close: () => void }) {
  const v = versionLabel(chosenVersion(s));
  const back = (
    <Button variant="ghost" icon="chevron-left" onClick={() => dispatch({ type: "back" })}>
      Back
    </Button>
  );
  const cancel = (
    <Button variant="secondary" onClick={close}>
      Cancel
    </Button>
  );
  const next = (
    <Button variant="primary" onClick={() => dispatch({ type: "next" })}>
      Continue
    </Button>
  );
  const hasChecks = warningsOf(s).length > 0;
  switch (s.step) {
    case "preparing":
      return cancel;
    case "stopped":
      return (
        <>
          {s.stop?.kind === "save" ? (
            <Button variant="secondary" icon="restart" onClick={() => dispatch({ type: "restart" })}>
              Try again
            </Button>
          ) : null}
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      );
    case "checks":
      return (
        <>
          {cancel}
          {next}
        </>
      );
    case "changes":
      return (
        <>
          {hasChecks ? back : cancel}
          {next}
        </>
      );
    case "version":
    case "note":
      return (
        <>
          {back}
          {next}
        </>
      );
    case "confirm":
      return (
        <>
          {back}
          <Button variant="accent" icon="publish" onClick={() => dispatch({ type: "publish" })}>
            Publish {v}
          </Button>
        </>
      );
    case "publishing":
    case "confirming":
      return (
        <Button variant="accent" busy>
          Publishing {v}
        </Button>
      );
    case "live":
      return (
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      );
    case "unconfirmed":
      return (
        <Button variant="primary" onClick={close}>
          Close
        </Button>
      );
    case "failed": {
      const f = s.failure!;
      const retry = f.kind === "offline" || f.kind === "other" || f.kind === "uncertain";
      const revise = f.kind === "version_taken" || f.kind === "bump_too_small";
      return (
        <>
          <Button variant={retry || revise ? "secondary" : "primary"} onClick={close}>
            Close
          </Button>
          {retry ? (
            <Button variant="primary" icon="restart" onClick={() => dispatch({ type: "retry" })}>
              Try again
            </Button>
          ) : null}
          {revise ? (
            <Button variant="primary" onClick={() => dispatch({ type: "revise" })}>
              Choose another version
            </Button>
          ) : null}
        </>
      );
    }
  }
}
