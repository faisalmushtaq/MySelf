import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import { releaseManifest, responseScale, type ReleaseManifest, type ResponseScale } from "@myself/schema";
import rawManifest from "@release-manifest";
import { flattenManifest } from "./lib/flatten.js";
import {
  appendEvent,
  completeSession,
  countStoredSessions,
  createSession,
  findResumableSession,
  loadAnswers,
  type SessionRow,
} from "./lib/db.js";
import { SurveyScreen } from "./components/SurveyScreen.js";

/**
 * MySelf Go — participant application (preview build).
 * Renders the frozen YBM r1.0.0 release entirely from its manifest, saves
 * every response to encrypted IndexedDB before advancing, works offline via
 * the service worker, and returns to a neutral start screen on handover.
 */

const manifest: ReleaseManifest = releaseManifest.parse(rawManifest);
const flattened = flattenManifest(manifest);
const scaleMap = new Map<string, ResponseScale>(
  Object.entries(manifest.scales).map(([k, v]) => [k, responseScale.parse(v)]),
);

type Phase = { kind: "start" } | { kind: "running"; session: SessionRow; index: number } | { kind: "finished"; session: SessionRow };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const [code, setCode] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [counts, setCounts] = useState({ inProgress: 0, completed: 0 });
  const [busy, setBusy] = useState(false);
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
        await appendEvent(session, "session.started", undefined, { releaseHash: manifest.hash }, 0, tMono());
      }
      storeRef.current = store;
      const w = new Walker(flattened.units, store, manifest.composition.allowBackNavigation);
      const index = existing ? Math.min(session.currentIndex, flattened.units.length - 1) : (w.first() ?? 0);
      setPhase({ kind: "running", session, index });
    } finally {
      setBusy(false);
    }
  }, [code, busy]);

  const record = useCallback(
    async (unit: PresentableUnit, value: AnswerValue) => {
      if (phase.kind !== "running") return;
      const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
      const had = storeRef.current.get(ref)?.status === "answered";
      storeRef.current.set(ref, { status: "answered", value });
      bumpAnswers();
      await appendEvent(
        phase.session,
        had ? "response.changed" : "response.recorded",
        `${unit.instrument}.${unit.item.key}`,
        value,
        phase.index,
        tMono(),
      );
      setSavedAt(new Date().toLocaleTimeString());
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
      const w = new Walker(flattened.units, storeRef.current, manifest.composition.allowBackNavigation);
      const next = w.next(from);
      if (next === null) {
        await appendEvent(phase.session, "session.completed", undefined, undefined, from, tMono());
        await completeSession(phase.session);
        setPhase({ kind: "finished", session: phase.session });
      } else {
        void appendEvent(phase.session, "item.presented", `${flattened.units[next]!.instrument}.${flattened.units[next]!.item.key}`, undefined, next, tMono());
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
        await appendEvent(phase.session, "navigation.back", undefined, { from, to: prev }, prev, tMono());
        setPhase({ kind: "running", session: phase.session, index: prev });
      }
    },
    [phase],
  );

  const handover = useCallback(() => {
    storeRef.current = new AnswerStore();
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
          <p className="study-title">{manifest.composition.title}</p>
          <label className="field">
            <span className="field-label">Enter your participant code</span>
            <input
              className="text-input code"
              value={code}
              autoCapitalize="characters"
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
            />
          </label>
          <button type="button" className="next big" disabled={code.trim().length < 2 || busy} onClick={() => void start()}>
            Start
          </button>
          <p className="hint demo-note">
            Preview build · release {manifest.release.version} · {manifest.hash?.slice(7, 19)} ·{" "}
            {counts.completed} completed session{counts.completed === 1 ? "" : "s"} stored on this device
          </p>
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
          onRecord={(u, v) => void record(u, v)}
          onAdvance={(f, k) => void advance(f, k)}
          onBack={(f) => void goBack(f)}
        />
      )}

      {phase.kind === "finished" && (
        <div className="screen finish">
          <h1>Thank you! 🎉</h1>
          <p>{manifest.composition.screens["finish"]?.body ?? "You've finished — thank you."}</p>
          <p className="hint">Your answers are saved safely on this device.</p>
          <button type="button" className="next big" onClick={handover}>
            Hand back to the researcher
          </button>
        </div>
      )}
    </div>
  );
}
