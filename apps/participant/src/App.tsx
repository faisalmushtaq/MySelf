import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import { releaseManifest, responseScale, scoringDefinition, type ReleaseManifest, type ResponseScale } from "@myself/schema";
import rawManifest from "../../../releases/ybm_nd2026_standard_r6.0.0.manifest.json";
import { flattenManifest } from "./lib/flatten.js";
import { resolveText, useScoringDefinitions } from "./lib/pipes.js";
import {
  appendEvent,
  completeSession,
  countStoredSessions,
  createSession,
  findResumableSession,
  loadAnswers,
  type SessionRow,
} from "./lib/db.js";
import { buildDeviceExport, downloadExport } from "./lib/export.js";
import { SessionTiming, wordCount } from "./lib/timing.js";
import { ReviewScreen } from "./components/ReviewScreen.js";
import { SurveyScreen } from "./components/SurveyScreen.js";

/**
 * MySelf Go — participant application (preview build).
 * Renders the frozen YBM r6.0.0 release entirely from its manifest, saves
 * every response to encrypted IndexedDB before advancing, works offline via
 * the service worker, and returns to a neutral start screen on handover.
 */

const manifest: ReleaseManifest = releaseManifest.parse(rawManifest);
const flattened = flattenManifest(manifest);
const scaleMap = new Map<string, ResponseScale>(
  Object.entries(manifest.scales).map(([k, v]) => [k, responseScale.parse(v)]),
);

// Scoring frozen into this release, so a `score` pipe can tell a participant
// something about what they just answered (D-33). Same definitions the server
// will recompute from, so a screen and an export can never disagree.
useScoringDefinitions(
  new Map(Object.entries(manifest.scoring).map(([k, v]) => [k, scoringDefinition.parse(v)])),
);

type Phase =
  | { kind: "start" }
  /** `fromReview` means this screen was opened to correct an answer, so
   *  finishing it goes back to the review rather than onward. */
  | { kind: "running"; session: SessionRow; index: number; fromReview?: boolean }
  | { kind: "checkin"; session: SessionRow; index: number; firstSkipped: number }
  | { kind: "pace"; session: SessionRow; index: number }
  /** The answer list, reached from the finish screen on request (D-31). */
  | { kind: "review"; session: SessionRow }
  | { kind: "finished"; session: SessionRow };

const unitKeyOf = (i: number) => {
  const u = flattened.units[i];
  return u ? `${u.instrument}.${u.item.key}` : "";
};

/**
 * How much reading a screen actually puts in front of someone — stem, lede,
 * and any consent statements. The too-fast threshold scales with it, so a
 * four-word battery item is not held to the same clock as a paragraph.
 */
const wordsAt = (i: number): number => {
  const item = flattened.units[i]?.item;
  if (!item) return 0;
  const statements = item.responseType === "checkbox_set" ? item.statements.map((st) => st.text.text) : [];
  return wordCount(item.stem.text, item.lede?.text, ...statements);
};

const effort = manifest.composition.effort;
const codeRule = manifest.composition.participantCode;
const contact = manifest.composition.contact;
const finishScreen = manifest.composition.screens["finish"];
const reviewScreen = manifest.composition.screens["review"];

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const [code, setCode] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [counts, setCounts] = useState({ inProgress: 0, completed: 0 });
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Handover is a researcher action on a device that spends its day in
  // participants' hands, so it sits behind a deliberate gesture on the build
  // line rather than a button anyone can find by wandering.
  const handoverTaps = useRef(0);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverNote, setHandoverNote] = useState<string | null>(null);
  // Consecutive skips, and where the run began, so a check-in can offer to
  // take the participant back to the first one they left blank.
  const skipRun = useRef<{ count: number; firstIndex: number | null }>({ count: 0, firstIndex: null });
  // Timing paradata for the live session, and the run of answers given faster
  // than the question could have been read.
  const timing = useRef(new SessionTiming(effort));
  const fastRun = useRef(0);
  // The AnswerStore is a mutable engine structure; bump re-renders explicitly
  // whenever it changes so controls reflect the recorded answer.
  const [, bumpAnswers] = useReducer((c: number) => c + 1, 0);
  const storeRef = useRef(new AnswerStore());
  const monoStart = useRef(performance.now());

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    void countStoredSessions().then(setCounts);
    void navigator.storage?.persist?.();
  }, [phase.kind]);

  const walker = useMemo(
    () => new Walker(flattened.units, storeRef.current, manifest.composition.allowBackNavigation),
    [phase.kind === "running" ? (phase as { session: SessionRow }).session.sessionId : ""],
  );

  const tMono = () => Math.round(performance.now() - monoStart.current);

  const start = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed.length < 2 || busy) return;
    if (codeRule && !new RegExp(codeRule.pattern).test(trimmed)) {
      setCodeError(codeRule.hint);
      return;
    }
    setCodeError(null);
    setBusy(true);
    try {
      const existing = await findResumableSession(trimmed, manifest.hash ?? "");
      const store = new AnswerStore();
      let session: SessionRow;
      if (existing) {
        const answers = await loadAnswers(existing.sessionId);
        for (const [key, rec] of answers) {
          const [instrument, item] = key.split(".") as [string, string];
          store.set({ instrument, item, revision: 1 }, rec);
        }
        session = existing;
      } else {
        session = await createSession(trimmed, manifest.release.key, manifest.hash ?? "");
        await appendEvent(
          session,
          "session.started",
          undefined,
          // The study code is captured here and stored against its variable, so
          // the survey never has to ask for it a second time (D-23).
          { releaseHash: manifest.hash, ...(codeRule?.variable ? { [codeRule.variable]: trimmed } : {}) },
          0,
          tMono(),
        );
      }
      storeRef.current = store;
      skipRun.current = { count: 0, firstIndex: null };
      fastRun.current = 0;
      timing.current = new SessionTiming(effort);
      const w = new Walker(flattened.units, store, manifest.composition.allowBackNavigation);
      const index = existing ? Math.min(session.currentIndex, flattened.units.length - 1) : (w.first() ?? 0);
      if (existing) {
        await appendEvent(session, "session.resumed", undefined, { resumedAtIndex: index }, index, tMono());
      }
      const firstKey = unitKeyOf(index);
      if (firstKey) {
        const { visit, returning, tooFastMs } = timing.current.enter(firstKey, wordsAt(index));
        void appendEvent(session, "item.presented", firstKey, { visit, returning, tooFastMs }, index, tMono());
      }
      setPhase({ kind: "running", session, index });
    } finally {
      setBusy(false);
    }
  }, [code, busy]);

  const record = useCallback(
    async (unit: PresentableUnit, value: AnswerValue) => {
      if (phase.kind !== "running") return;
      const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
      const itemKey = `${unit.instrument}.${unit.item.key}`;
      const had = storeRef.current.get(ref)?.status === "answered";
      storeRef.current.set(ref, { status: "answered", value });
      bumpAnswers();
      const t = timing.current.recordResponse(itemKey, had);
      await appendEvent(
        phase.session,
        had ? "response.changed" : "response.recorded",
        itemKey,
        // Timing rides with the response so a single event carries both what
        // was answered and how long it took to answer it.
        { value, timing: t },
        phase.index,
        tMono(),
      );
      // The answer stands either way — this only records that it arrived
      // faster than the question could have been read.
      if (t.tooFast) {
        fastRun.current += 1;
        await appendEvent(
          phase.session,
          "response.too_fast",
          itemKey,
          { sinceShownMs: t.sinceShownMs, thresholdMs: t.thresholdMs, run: fastRun.current },
          phase.index,
          tMono(),
        );
      } else {
        fastRun.current = 0;
      }
      setSavedAt(new Date().toLocaleTimeString());
    },
    [phase],
  );

  const emit = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      if (phase.kind !== "running") return;
      const unit = flattened.units[phase.index];
      void appendEvent(
        phase.session,
        type,
        unit ? `${unit.instrument}.${unit.item.key}` : undefined,
        payload,
        phase.index,
        tMono(),
      );
    },
    [phase],
  );

  /** Open a viewing of an item: `item.presented` carries the visit number, so
   *  returning to a question is visible in the log rather than inferred. */
  const enterItem = useCallback(
    (index: number) => {
      if (phase.kind === "start" || phase.kind === "finished") return;
      const key = unitKeyOf(index);
      if (!key) return;
      const { visit, returning, tooFastMs } = timing.current.enter(key, wordsAt(index));
      void appendEvent(phase.session, "item.presented", key, { visit, returning, tooFastMs }, index, tMono());
    },
    [phase],
  );

  /** Close a viewing of an item, recording how long it was on screen. */
  const leaveItem = useCallback(
    async (index: number, answered: boolean) => {
      if (phase.kind === "start" || phase.kind === "finished") return;
      const key = unitKeyOf(index);
      if (!key) return;
      const payload = timing.current.leave(key, answered);
      if (payload) await appendEvent(phase.session, "item.left", key, payload, index, tMono());
    },
    [phase],
  );

  const advance = useCallback(
    async (from: number, kind: "next" | "skip" | "decline") => {
      if (phase.kind !== "running") return;
      const unit = flattened.units[from];
      if (unit && (kind === "skip" || kind === "decline")) {
        const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
        storeRef.current.set(ref, { status: kind === "skip" ? "skipped" : "declined" });
        bumpAnswers();
        await appendEvent(
          phase.session,
          kind === "skip" ? "item.skipped" : "item.declined",
          `${unit.instrument}.${unit.item.key}`,
          undefined,
          from,
          tMono(),
        );
        setSavedAt(new Date().toLocaleTimeString());
      }
      // Track runs of consecutive skips/declines so we can check in gently.
      if (kind === "skip" || kind === "decline") {
        if (skipRun.current.count === 0) skipRun.current.firstIndex = from;
        skipRun.current.count += 1;
      } else {
        skipRun.current = { count: 0, firstIndex: null };
      }

      // Close this viewing of the item: one event per visit, carrying the dwell
      // for that visit and the running total across visits.
      await leaveItem(from, kind !== "skip" && kind !== "decline");

      // Opened from the review to correct one answer: go straight back to the
      // list rather than walking the rest of the survey again.
      if (phase.fromReview) {
        await appendEvent(phase.session, "review.edited", unitKeyOf(from), undefined, from, tMono());
        setPhase({ kind: "review", session: phase.session });
        return;
      }

      const w = new Walker(flattened.units, storeRef.current, manifest.composition.allowBackNavigation);
      const next = w.next(from);

      if (
        next !== null &&
        skipRun.current.count >= effort.skipRunCheckIn &&
        skipRun.current.firstIndex !== null
      ) {
        const firstSkipped = skipRun.current.firstIndex;
        skipRun.current = { count: 0, firstIndex: null };
        await appendEvent(phase.session, "effort.checkin_shown", undefined, { firstSkipped }, next, tMono());
        setPhase({ kind: "checkin", session: phase.session, index: next, firstSkipped });
        return;
      }

      // A run of answers given faster than they could be read: ask once,
      // without accusing anyone, then reset and carry on either way.
      if (next !== null && effort.tooFastRunPrompt > 0 && fastRun.current >= effort.tooFastRunPrompt) {
        fastRun.current = 0;
        await appendEvent(phase.session, "effort.pace_prompt_shown", undefined, undefined, next, tMono());
        setPhase({ kind: "pace", session: phase.session, index: next });
        return;
      }

      if (next === null) {
        // The last question leads to "you've finished" — not to a wall of
        // everything they just answered. The review is offered there, for the
        // minority who know they got something wrong (D-31).
        await appendEvent(phase.session, "session.completed", undefined, timing.current.summary(), from, tMono());
        await completeSession(phase.session);
        setPhase({ kind: "finished", session: phase.session });
      } else {
        void enterItem(next);
        setPhase({ kind: "running", session: phase.session, index: next });
      }
    },
    [phase],
  );

  const goBack = useCallback(
    async (from: number) => {
      if (phase.kind !== "running") return;
      const w = new Walker(flattened.units, storeRef.current, manifest.composition.allowBackNavigation);
      const prev = w.back(from);
      if (prev !== null) {
        await leaveItem(from, false);
        await appendEvent(phase.session, "navigation.back", undefined, { from, to: prev }, prev, tMono());
        enterItem(prev);
        setPhase({ kind: "running", session: phase.session, index: prev });
      }
    },
    [phase],
  );

  /**
   * The iPad being locked, handed over or switched away from is part of how a
   * session actually went. Recording it means a long gap can be told apart
   * from a long think, and stops "time on question" quietly counting the
   * lunch break.
   */
  useEffect(() => {
    if (phase.kind !== "running") return;
    const session = phase.session;
    const onVisibility = () => {
      if (document.hidden) {
        const s = timing.current.suspend();
        if (s) void appendEvent(session, "session.suspended", undefined, s, phase.index, tMono());
      } else {
        const r = timing.current.resume();
        if (r) void appendEvent(session, "session.resumed", undefined, r, phase.index, tMono());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phase.kind, phase.kind === "running" ? phase.index : -1]);

  const handover = useCallback(() => {
    storeRef.current = new AnswerStore();
    timing.current = new SessionTiming(effort);
    fastRun.current = 0;
    setCode("");
    setSavedAt(null);
    setPhase({ kind: "start" });
  }, []);

  return (
    <div className="app">
      <div className="status-strip" aria-live="polite">
        <span className={`dot ${online ? "online" : "offline"}`} />
        <span className="status-text">{online ? "Online" : "Offline — everything is saved on this device"}</span>
        {savedAt && phase.kind === "running" && <span className="saved">Saved ✓</span>}
      </div>

      {phase.kind === "start" && (
        <div className="screen start">
          <h1 className="brand">MySelf</h1>
          <p className="subbrand">MyThoughts</p>
          {manifest.composition.studyLabel && (
            <p className="study-title">{manifest.composition.studyLabel}</p>
          )}
          {/* The code the research team issued, entered once before anything
              else. It used to be asked again mid-survey; now it is captured
              here and carried through, so nobody types it twice. */}
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
                // Codes are letters and digits only; punctuation and spaces
                // are dropped as they are typed rather than rejected later.
                setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16));
                if (codeError) setCodeError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
            />
            {codeError && (
              <span className="error" role="alert">
                {codeError}
              </span>
            )}
          </label>
          <button type="button" className="next big" disabled={code.trim().length < 2 || busy} onClick={() => void start()}>
            Start
          </button>
          <p
            className="hint demo-note"
            onClick={() => {
              handoverTaps.current += 1;
              if (handoverTaps.current >= 5) {
                handoverTaps.current = 0;
                setHandoverOpen((v) => !v);
              }
            }}
          >
            Preview build · release {manifest.release.version} · {manifest.hash?.slice(7, 19)} ·{" "}
            {counts.completed} completed session{counts.completed === 1 ? "" : "s"} stored on this device · build{" "}
            {__BUILD_STAMP__}
          </p>
          {handoverOpen && (
            <div className="handover">
              <h2>Handover</h2>
              <p className="hint">
                {counts.completed} completed and {counts.inProgress} unfinished session
                {counts.inProgress === 1 ? "" : "s"} on this device. The file contains real answers: put it
                straight into approved storage, and only delete anything here once it has landed.
              </p>
              <div className="handover-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={counts.completed === 0}
                  onClick={() => {
                    void (async () => {
                      const data = await buildDeviceExport();
                      downloadExport(data);
                      setHandoverNote(`${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} written`);
                    })();
                  }}
                >
                  Export completed sessions
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={counts.completed + counts.inProgress === 0}
                  onClick={() => {
                    void (async () => {
                      const data = await buildDeviceExport({ includeInProgress: true });
                      downloadExport(data, "device-all");
                      setHandoverNote(`${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} written, unfinished included`);
                    })();
                  }}
                >
                  Include unfinished
                </button>
              </div>
              {handoverNote && <p className="hint">{handoverNote}</p>}
            </div>
          )}
          {contact && (
            <p className="start-footer">
              {contact.ethicsReference && <>Ethics reference {contact.ethicsReference}. </>}
              Any questions, email <a href={`mailto:${contact.email}`}>{contact.email}</a>.
              {contact.note && <> {contact.note}</>}
            </p>
          )}
        </div>
      )}

      {phase.kind === "running" && (
        <SurveyScreen
          units={flattened.units}
          scales={scaleMap}
          store={storeRef.current}
          allowBack={manifest.composition.allowBackNavigation}
          sectionTitles={flattened.sectionTitles}
          index={phase.index}
          sessionStart={new Date(phase.session.startedAt)}
          effort={effort}
          context={flattened.context.get(phase.index)}
          onRecord={(u, v) => void record(u, v)}
          onAdvance={(f, k) => void advance(f, k)}
          onBack={(f) => void goBack(f)}
          onEvent={emit}
        />
      )}

      {phase.kind === "pace" && (
        <div className="screen checkin">
          <h1>No rush</h1>
          <p>
            The last few answers came in very quickly. There&apos;s no time limit here, and no right answers — take
            as long as you like reading each one.
          </p>
          <div className="checkin-actions">
            <button
              type="button"
              className="next big"
              onClick={() => {
                enterItem(phase.index);
                setPhase({ kind: "running", session: phase.session, index: phase.index });
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
            You&apos;ve left the last few questions blank. That&apos;s completely allowed — but if any of them
            were skipped by accident, you can go back to them now.
          </p>
          <div className="checkin-actions">
            <button
              type="button"
              className="next big"
              onClick={() => {
                void appendEvent(phase.session, "effort.checkin_returned", undefined, { to: phase.firstSkipped }, phase.firstSkipped, tMono());
                enterItem(phase.firstSkipped);
                setPhase({ kind: "running", session: phase.session, index: phase.firstSkipped });
              }}
            >
              Go back to them
            </button>
            <button
              type="button"
              className="decline"
              onClick={() => {
                enterItem(phase.index);
                setPhase({ kind: "running", session: phase.session, index: phase.index });
              }}
            >
              Keep going
            </button>
          </div>
        </div>
      )}

      {phase.kind === "review" && reviewScreen && (
        <ReviewScreen
          units={flattened.units}
          scales={scaleMap}
          store={storeRef.current}
          allowBack={manifest.composition.allowBackNavigation}
          sectionTitles={flattened.sectionTitles}
          sessionStart={new Date(phase.session.startedAt)}
          title={reviewScreen.title ? resolveText(reviewScreen.title.text, reviewScreen.title.pipes, storeRef.current, new Date(phase.session.startedAt)) : "Change an answer"}
          body={resolveText(reviewScreen.body.text, reviewScreen.body.pipes, storeRef.current, new Date(phase.session.startedAt))}
          onEdit={(index) => {
            void appendEvent(phase.session, "review.opened", unitKeyOf(index), { editing: true }, index, tMono());
            const key = unitKeyOf(index);
            if (key) timing.current.enter(key, wordsAt(index));
            setPhase({ kind: "running", session: phase.session, index, fromReview: true });
          }}
          onFinish={() => {
            void (async () => {
              // Coming back from a change re-completes the session, so the
              // completion event always follows the last edit in the log.
              await appendEvent(phase.session, "session.completed", undefined, timing.current.summary(), 0, tMono());
              await completeSession(phase.session);
              setPhase({ kind: "finished", session: phase.session });
            })();
          }}
        />
      )}

      {phase.kind === "finished" && (
        <div className="screen finish">
          {/* The name given at the very start, used at the very end. Both the
              title and the body are piped like any other participant text, so
              this is a release decision rather than something coded here. */}
          <h1>
            {finishScreen?.title
              ? resolveText(finishScreen.title.text, finishScreen.title.pipes, storeRef.current, new Date(phase.session.startedAt))
              : "Thank you!"}{" "}
            🎉
          </h1>
          <p>
            {finishScreen
              ? resolveText(finishScreen.body.text, finishScreen.body.pipes, storeRef.current, new Date(phase.session.startedAt))
              : "You've finished — thank you."}
          </p>
          <p className="hint">Your answers are saved safely on this device.</p>

          {/* Offered, not imposed. Most people are done when they are done;
              the list is there for the minority who know they got something
              wrong, and it sits below the finish message rather than in front
              of it (D-31). */}
          {reviewScreen && (
            <div className="finish-amend">
              <p className="finish-amend-q">Need to change anything?</p>
              <button
                type="button"
                className="finish-amend-go"
                onClick={() => {
                  void appendEvent(phase.session, "review.opened", undefined, { from: "finish" }, 0, tMono());
                  setPhase({ kind: "review", session: phase.session });
                }}
              >
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
