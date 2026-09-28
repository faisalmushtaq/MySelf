import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import {
  responseScale,
  scoringDefinition,
  type AssessmentDraft,
  type ReleaseManifest,
  type ResponseScale,
} from "@myself/schema";
import { flattenManifest, type FlattenedRelease } from "@participant/lib/flatten.js";
import { resolveText, useScoringDefinitions } from "@participant/lib/pipes.js";
import { SessionTiming, wordCount } from "@participant/lib/timing.js";
import type { AccessibilityPreferences } from "@participant/lib/accessibility.js";
import { SurveyScreen } from "@participant/components/SurveyScreen.js";
import { ReviewScreen, describeAnswer } from "@participant/components/ReviewScreen.js";
import { answerSummaries, computeVisibility, resolveStart, unitKeyOf, type StartPoint } from "./path.js";
import type { PreviewPhase, StartAt, StateMessage } from "./protocol.js";

/**
 * The participant app's survey, run from a draft, with nothing kept.
 *
 * A reproduction of apps/participant/src/App.tsx from the start screen on:
 * the same screens (SurveyScreen, ReviewScreen and their controls, imported,
 * not copied), the same walk (Walker over flattenManifest's units), the same
 * pipes, the skip check-in, the pace prompt, review editing with "Back to
 * summary", and the finish screen. What a researcher steps through here is
 * what a participant would.
 *
 * WHAT IS LEFT OUT IS EVERYTHING THAT KEEPS A SITTING. App.tsx writes every
 * event through lib/db.ts to IndexedDB and uploads through lib/sync.ts. None
 * of that is imported here, or anywhere the frame can reach — the isolation
 * test walks the imports and the build refuses a preview bundle that could —
 * so the answer store below is the only place an answer ever exists, and it is
 * dropped with the component. The participant's database shares this origin;
 * the preview cannot open it because it does not contain the code to.
 *
 * When this and App.tsx differ, App.tsx is right: the comments on each
 * handler name what they mirror, so a change there is easy to carry across.
 */

export interface PreparedRelease {
  manifest: ReleaseManifest;
  flattened: FlattenedRelease;
  scales: Map<string, ResponseScale>;
}

/**
 * Get a release ready to run, as App.tsx does at module load — once per load
 * here, since the release changes as the draft does. Throws on a release the
 * participant app could not run either; the frame reports that rather than
 * showing half a survey.
 */
export function prepareRelease(manifest: ReleaseManifest): PreparedRelease {
  const flattened = flattenManifest(manifest);
  const scales = new Map<string, ResponseScale>(
    Object.entries(manifest.scales).map(([k, v]) => [k, responseScale.parse(v)]),
  );
  // Not a React hook, despite the name: it sets the definitions `score` pipes
  // read. One release runs in a frame at a time, so a module-level setting is
  // exactly as right here as it is in the participant app.
  useScoringDefinitions(new Map(Object.entries(manifest.scoring).map(([k, v]) => [k, scoringDefinition.parse(v)])));
  return { manifest, flattened, scales };
}

/** Why a release could not be prepared, per field where zod says so. */
export function describeFailure(error: unknown): string {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
  if (Array.isArray(issues)) {
    return issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(release)"}: ${i.message}`)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export type RunnerState = Omit<StateMessage, "type" | "nonce">;

export interface PreviewRunnerProps {
  release: PreparedRelease;
  startAt: StartAt;
  /** A jump asked for by the Studio. `seq` changes with every request, including a repeat of the same target. */
  jump: { target: string; seq: number } | null;
  accessibility: AccessibilityPreferences;
  onAccessibility: (next: AccessibilityPreferences) => void;
  onState: (state: RunnerState) => void;
}

type Phase =
  | { kind: "start" }
  /** `fromReview`: opened to correct one answer, so finishing it returns to the review (App.tsx). */
  | { kind: "running"; index: number; fromReview?: boolean }
  | { kind: "checkin"; index: number; firstSkipped: number }
  | { kind: "pace"; index: number }
  | { kind: "review" }
  | { kind: "finished" };

const phaseAt = (point: StartPoint): Phase =>
  point.kind === "running" ? { kind: "running", index: point.index } : point;

// Events are the sitting's log in App.tsx. There is no log here, so the
// screens' paradata goes nowhere, on purpose.
const noEvent = () => undefined;

export function PreviewRunner({ release, startAt, jump, accessibility, onAccessibility, onState }: PreviewRunnerProps) {
  const { manifest, flattened, scales } = release;
  const units = flattened.units;
  const composition = manifest.composition;
  const effort = composition.effort;
  const allowBack = composition.allowBackNavigation;
  const finishScreen = composition.screens["finish"];
  const reviewScreen = composition.screens["review"];

  const storeRef = useRef(new AnswerStore());
  // Which screens this run has put in front of the participant, for the path
  // panel's "seen". Not something App.tsx keeps: it is the log's job there.
  const visited = useRef(new Set<string>());
  const timing = useRef(new SessionTiming(effort));
  const fastRun = useRef(0);
  const skipRun = useRef<{ count: number; firstIndex: number | null }>({ count: 0, firstIndex: null });
  const sessionStart = useRef(new Date());
  // The AnswerStore is a mutable engine structure; bump re-renders explicitly
  // whenever it changes so controls reflect the recorded answer (App.tsx).
  const [answersVersion, bumpAnswers] = useReducer((c: number) => c + 1, 0);

  const [phase, setPhase] = useState<Phase>(() => phaseAt(resolveStart(units, startAt, reviewScreen !== undefined)));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const keyAt = (i: number): string => {
    const u = units[i];
    return u ? unitKeyOf(u) : "";
  };

  /** As App.tsx `wordsAt`: how much reading the screen puts in front of someone. */
  const wordsAt = (i: number): number => {
    const item = units[i]?.item;
    if (!item) return 0;
    const statements = item.responseType === "checkbox_set" ? item.statements.map((st) => st.text.text) : [];
    return wordCount(item.stem.text, item.lede?.text, ...statements);
  };

  /** As App.tsx `enterItem`, minus the `item.presented` event. */
  const enterItem = (index: number) => {
    const key = keyAt(index);
    if (!key) return;
    timing.current.enter(key, wordsAt(index));
    visited.current.add(key);
  };

  /** As App.tsx `leaveItem`, minus the `item.left` event. */
  const leaveItem = (index: number, answered: boolean) => {
    const key = keyAt(index);
    if (key) timing.current.leave(key, answered);
  };

  /** A new sitting: what App.tsx's `start` and `handover` reset between participants. */
  const freshSitting = () => {
    storeRef.current = new AnswerStore();
    visited.current = new Set();
    timing.current = new SessionTiming(effort);
    fastRun.current = 0;
    skipRun.current = { count: 0, firstIndex: null };
    sessionStart.current = new Date();
    bumpAnswers();
  };

  // A load that starts part-way in opens that screen as App.tsx opens the first.
  // Guarded, so React's development double-mount does not count two visits.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (phase.kind === "running") enterItem(phase.index);
  }, []);

  /** As App.tsx `start`, from the point the code is accepted. */
  const begin = () => {
    freshSitting();
    if (units.length === 0) {
      setPhase({ kind: "finished" });
      return;
    }
    const index = new Walker(units, storeRef.current, allowBack).first() ?? 0;
    enterItem(index);
    setPhase({ kind: "running", index });
  };

  /** As App.tsx `record`: the answer into the store, and the too-fast run. */
  const record = useCallback(
    (unit: PresentableUnit, value: AnswerValue) => {
      if (phaseRef.current.kind !== "running") return;
      const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
      const had = storeRef.current.get(ref)?.status === "answered";
      storeRef.current.set(ref, { status: "answered", value });
      bumpAnswers();
      const t = timing.current.recordResponse(unitKeyOf(unit), had);
      if (t.tooFast) fastRun.current += 1;
      else fastRun.current = 0;
    },
    [],
  );

  /** As App.tsx `advance`. */
  const advance = useCallback(
    (from: number, kind: "next" | "skip" | "decline") => {
      const current = phaseRef.current;
      if (current.kind !== "running") return;
      const unit = units[from];
      if (unit && (kind === "skip" || kind === "decline")) {
        const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
        storeRef.current.set(ref, { status: kind === "skip" ? "skipped" : "declined" });
        bumpAnswers();
      }
      // Runs of consecutive skips/declines, so the check-in can offer a way back.
      if (kind === "skip" || kind === "decline") {
        if (skipRun.current.count === 0) skipRun.current.firstIndex = from;
        skipRun.current.count += 1;
      } else {
        skipRun.current = { count: 0, firstIndex: null };
      }

      leaveItem(from, kind !== "skip" && kind !== "decline");

      if (current.fromReview) {
        setPhase({ kind: "review" });
        return;
      }

      const next = new Walker(units, storeRef.current, allowBack).next(from);

      if (next !== null && skipRun.current.count >= effort.skipRunCheckIn && skipRun.current.firstIndex !== null) {
        const firstSkipped = skipRun.current.firstIndex;
        skipRun.current = { count: 0, firstIndex: null };
        setPhase({ kind: "checkin", index: next, firstSkipped });
        return;
      }

      if (next !== null && effort.tooFastRunPrompt > 0 && fastRun.current >= effort.tooFastRunPrompt) {
        fastRun.current = 0;
        setPhase({ kind: "pace", index: next });
        return;
      }

      if (next === null) {
        setPhase({ kind: "finished" });
      } else {
        enterItem(next);
        setPhase({ kind: "running", index: next });
      }
    },
    // No dependencies: the release is fixed for this runner's life (a new
    // load remounts it), and the phase is read through its ref.
    [],
  );

  /** As App.tsx `goBack`, including "Back to summary" when correcting one answer. */
  const goBack = useCallback(
    (from: number) => {
      const current = phaseRef.current;
      if (current.kind !== "running") return;
      if (current.fromReview) {
        leaveItem(from, false);
        setPhase({ kind: "review" });
        return;
      }
      const prev = new Walker(units, storeRef.current, allowBack).back(from);
      if (prev !== null) {
        leaveItem(from, false);
        enterItem(prev);
        setPhase({ kind: "running", index: prev });
      }
    },
    [],
  );

  /** App.tsx `handover`: back to the start screen, with nothing carried over. */
  const handover = () => {
    freshSitting();
    setPhase({ kind: "start" });
  };

  // A jump from the Studio's path panel: go there, keeping every answer, so
  // the conditions that decide what is shown still hold. ("Start from…" is a
  // load, not a jump: it starts over.)
  useEffect(() => {
    if (!jump) return;
    const point = resolveStart(units, jump.target, reviewScreen !== undefined);
    if (point.kind === "start") return; // not a screen in this release
    const current = phaseRef.current;
    if (current.kind === "running") leaveItem(current.index, false);
    // A jump is not a run of skips; do not let it trigger the check-in.
    skipRun.current = { count: 0, firstIndex: null };
    if (point.kind === "running") enterItem(point.index);
    setPhase(phaseAt(point));
    // Keyed on the request number alone: only a new request moves the preview.
  }, [jump?.seq]);

  // Tell the Studio where the run is after every move and every answer.
  useEffect(() => {
    const index = phase.kind === "running" || phase.kind === "checkin" || phase.kind === "pace" ? phase.index : null;
    onState({
      phase: phase.kind satisfies PreviewPhase,
      index,
      itemKey: index === null ? null : keyAt(index) || null,
      answers: answerSummaries(units, storeRef.current, scales, describeAnswer),
      visibility: computeVisibility(units, storeRef.current, visited.current),
    });
  }, [phase, answersVersion]);

  const piped = (text: { text: string; pipes?: Parameters<typeof resolveText>[1] } | undefined, fallback: string) =>
    text ? resolveText(text.text, text.pipes, storeRef.current, sessionStart.current) : fallback;

  return (
    <div className="app">
      {/* Where App.tsx says "Online" and "Saved ✓". Neither is true of a
          preview, so the strip says what is. */}
      <div className="status-strip">
        <span className="status-text">Preview · nothing here is saved or sent</span>
      </div>

      {phase.kind === "start" && (
        <StartScreen
          composition={composition}
          accessibility={accessibility}
          onAccessibility={onAccessibility}
          onStart={begin}
        />
      )}

      {phase.kind === "running" && (
        <SurveyScreen
          units={units}
          scales={scales}
          store={storeRef.current}
          allowBack={allowBack}
          sectionTitles={flattened.sectionTitles}
          index={phase.index}
          sessionStart={sessionStart.current}
          effort={effort}
          context={flattened.context.get(phase.index)}
          // No module URL: a narrative position says, as it does on a device
          // with no module configured, that this part is not available — and
          // never opens a conversation, which would be a real run.
          narrative={{ moduleUrl: null, sessionId: "studio-preview", releaseHash: "" }}
          onRecord={record}
          onAdvance={advance}
          onBack={goBack}
          onEvent={noEvent}
          reviewEdit={phase.fromReview === true}
        />
      )}

      {phase.kind === "pace" && (
        <div className="screen checkin">
          <h1>No rush</h1>
          <p>
            The last few answers came in very quickly. There&apos;s no time limit here, and no right answers — take as
            long as you like reading each one.
          </p>
          <div className="checkin-actions">
            <button
              type="button"
              className="next big"
              onClick={() => {
                enterItem(phase.index);
                setPhase({ kind: "running", index: phase.index });
              }}
            >
              Carry on
            </button>
          </div>
        </div>
      )}

      {phase.kind === "checkin" && (
        <div className="screen checkin">
          <h1>Just checking in</h1>
          <p>
            You&apos;ve left the last few questions blank. That&apos;s completely allowed — but if any of them were
            skipped by accident, you can go back to them now.
          </p>
          <div className="checkin-actions">
            <button
              type="button"
              className="next big"
              onClick={() => {
                enterItem(phase.firstSkipped);
                setPhase({ kind: "running", index: phase.firstSkipped });
              }}
            >
              Go back to them
            </button>
            <button
              type="button"
              className="decline"
              onClick={() => {
                enterItem(phase.index);
                setPhase({ kind: "running", index: phase.index });
              }}
            >
              Keep going
            </button>
          </div>
        </div>
      )}

      {phase.kind === "review" && reviewScreen && (
        <ReviewScreen
          units={units}
          scales={scales}
          store={storeRef.current}
          allowBack={allowBack}
          sectionTitles={flattened.sectionTitles}
          sessionStart={sessionStart.current}
          title={piped(reviewScreen.title, "Change an answer")}
          body={piped(reviewScreen.body, "")}
          onEdit={(index) => {
            enterItem(index);
            setPhase({ kind: "running", index, fromReview: true });
          }}
          onFinish={() => setPhase({ kind: "finished" })}
        />
      )}

      {phase.kind === "finished" && (
        <div className="screen finish">
          <h1>{piped(finishScreen?.title, "Thank you!")} 🎉</h1>
          <p>{piped(finishScreen?.body, "You've finished — thank you.")}</p>
          <p className="hint">Your answers are saved safely on this device.</p>
          {reviewScreen && (
            <div className="finish-amend">
              <p className="finish-amend-q">Need to change anything?</p>
              <button type="button" className="finish-amend-go" onClick={() => setPhase({ kind: "review" })}>
                Go back to my answers
              </button>
            </div>
          )}
          <button type="button" className="next big" onClick={handover}>
            Hand back to the researcher
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * App.tsx's start screen, as a participant sees it before a sitting exists.
 *
 * The code is checked against the survey's own rule exactly as the app checks
 * it, so a researcher can try the rule out. It is optional here — typing a
 * valid code before every restart would make the preview a chore — and the
 * screen says so, in the one line on it a participant would not see.
 */
function StartScreen({
  composition,
  accessibility,
  onAccessibility,
  onStart,
}: {
  composition: AssessmentDraft;
  accessibility: AccessibilityPreferences;
  onAccessibility: (next: AccessibilityPreferences) => void;
  onStart: () => void;
}) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeRule = composition.participantCode;
  const contact = composition.contact;

  const start = () => {
    const trimmed = code.trim();
    if (trimmed.length > 0) {
      if (trimmed.length < 2) {
        setCodeError(codeRule?.hint ?? "Codes are at least two letters or numbers.");
        return;
      }
      if (codeRule) {
        let matches: boolean;
        try {
          matches = new RegExp(codeRule.pattern).test(trimmed);
        } catch {
          // The participant app would fail here with nobody told why.
          setCodeError("The survey's code rule is not a pattern the app can read, so no code would be accepted.");
          return;
        }
        if (!matches) {
          setCodeError(codeRule.hint);
          return;
        }
      }
    }
    setCodeError(null);
    onStart();
  };

  const update = (patch: Partial<AccessibilityPreferences>) => onAccessibility({ ...accessibility, ...patch });

  return (
    <div className="screen start">
      <h1 className="brand">MySelf</h1>
      <p className="subbrand">MyThoughts</p>
      {composition.studyLabel && <p className="study-title">{composition.studyLabel}</p>}
      {codeRule?.instructions && <p className="start-instructions">{codeRule.instructions}</p>}
      <label className="field code-field">
        <span className="field-label">{codeRule?.label ?? "Your participant code"}</span>
        <input
          className="text-input code"
          value={code}
          placeholder={codeRule?.placeholder ?? "NDC0000"}
          autoCapitalize="characters"
          autoComplete="off"
          aria-invalid={codeError !== null}
          maxLength={16}
          onChange={(e) => {
            setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16));
            if (codeError) setCodeError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") start();
          }}
        />
        {codeError && (
          <span className="error" role="alert">
            {codeError}
          </span>
        )}
      </label>
      <button type="button" className="next big" onClick={start}>
        Start
      </button>
      <p className="hint pv-note">Preview only: you can start without a code. A participant can&apos;t.</p>
      <details className="reading-settings">
        <summary>Reading settings</summary>
        <p className="reading-settings-intro">
          Choose the display that feels clearest. These preferences stay on this device and are never included in
          study data.
        </p>
        <div className="reading-settings-row">
          <span className="reading-settings-label">Text size</span>
          <div className="reading-settings-options" role="group" aria-label="Text size">
            {(["default", "large", "extra_large"] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={`reading-settings-choice ${accessibility.textSize === size ? "selected" : ""}`}
                aria-pressed={accessibility.textSize === size}
                onClick={() => update({ textSize: size })}
              >
                {size === "default" ? "Default" : size === "large" ? "Large" : "Extra large"}
              </button>
            ))}
          </div>
        </div>
        <div className="reading-settings-row">
          <span className="reading-settings-label">Contrast</span>
          <div className="reading-settings-options" role="group" aria-label="Contrast">
            {(["standard", "high", "dark"] as const).map((contrast) => (
              <button
                key={contrast}
                type="button"
                className={`reading-settings-choice ${accessibility.contrast === contrast ? "selected" : ""}`}
                aria-pressed={accessibility.contrast === contrast}
                onClick={() => update({ contrast })}
              >
                {contrast === "standard" ? "Standard" : contrast === "high" ? "High" : "Dark"}
              </button>
            ))}
          </div>
        </div>
        <label className="reading-settings-toggle">
          <input
            type="checkbox"
            checked={accessibility.dyslexiaFriendly}
            onChange={(event) => update({ dyslexiaFriendly: event.target.checked })}
          />
          <span>Dyslexia-friendly reading mode</span>
        </label>
      </details>
      <p className="hint demo-note">Studio preview of the current draft · answers stay in this tab</p>
      {contact && (
        <p className="start-footer">
          {contact.ethicsReference && <>Ethics reference {contact.ethicsReference}. </>}
          Any questions, email <a href={`mailto:${contact.email}`}>{contact.email}</a>.
          {contact.note && <> {contact.note}</>}
        </p>
      )}
    </div>
  );
}
