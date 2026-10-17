import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import { choiceKey, readTypedChoice, sameChoice, type LinkReading, type SurveyChoice } from "@myself/schema";
import { resolveText, useScoringDefinitions } from "./lib/pipes.js";
import {
  accessibilityPreferences,
  appendEvent,
  completeSession,
  clearBackoff,
  countStoredSessions,
  createSession,
  findResumableSession,
  loadAnswers,
  saveAccessibilityPreferences,
  deviceSummary,
  forgetConfirmedSessions,
  unfinishedElsewhere,
  type Enrolment,
  type SelectionRow,
  type SessionRow,
  type StoredSessionCounts,
} from "./lib/db.js";
import { buildSealedExport, downloadExport } from "./lib/export.js";
import { passphraseComplaint } from "@myself/store";
import {
  applyAccessibilityPreferences,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  type AccessibilityPreferences,
} from "./lib/accessibility.js";
import { checkpointRunningSessions, synchroniseCompletedSessions } from "./lib/sync.js";
import { currentDevice, syncAvailable, syncTarget } from "./lib/device.js";
import { moduleCredential } from "./lib/narrative.js";
import { updates } from "./lib/updates.js";
import { deviceSpace, readableBytes, type Space } from "./lib/space.js";
import {
  EVICTION_CAP_DAYS,
  HELD_TOO_LONG_DAYS,
  heldForDays,
  storageDurability,
  type Durability,
} from "./lib/durability.js";
import { SessionTiming } from "./lib/timing.js";
import { BUILT_IN, describeCheck, pruneReleases, type CheckRecord, type LoadedRelease } from "./lib/releases.js";
import { buildRuntime, type Runtime } from "./lib/runtime.js";
import { sittingToResume, type ResumeLookup } from "./lib/resume.js";
import {
  checkChoice,
  DEFAULT_CHOICE,
  isDefaultChoice,
  planLink,
  rememberChoice,
  rememberLinkFollowed,
  serviceFor,
  storedChoice,
  verdictOf,
} from "./lib/selection.js";
import { ReviewScreen } from "./components/ReviewScreen.js";
import { SurveyScreen } from "./components/SurveyScreen.js";
import { CheckInScreen } from "./screens/CheckInScreen.js";
import { FinishScreen } from "./screens/FinishScreen.js";
import { HandoverPanel } from "./screens/HandoverPanel.js";
import { PaceScreen } from "./screens/PaceScreen.js";
import { SaveFailedScreen } from "./screens/SaveFailedScreen.js";
import { StartScreen, type StartNotice } from "./screens/StartScreen.js";
import type { PanelCheck } from "./screens/SurveyChoiceSection.js";

/**
 * MySelf Go — participant application (preview build).
 * Renders a frozen release entirely from its manifest — the one the study has
 * published, once this device has downloaded and verified it, and the built-in
 * YBM r8.0.0 until then (lib/releases.ts) — saves every response to encrypted
 * IndexedDB before advancing, works offline via the service worker, and returns
 * to a neutral start screen on handover.
 */

/**
 * How often the start screen asks the study whether a new version is live.
 *
 * Slow on purpose. The check that matters is the one made every time the device
 * comes back to the start screen, which is between participants; this timer only
 * covers an iPad left idle on a table, and thirty of them asking every minute is
 * traffic a hall's single access point does not need.
 */
const RELEASE_CHECK_MS = 5 * 60_000;

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

/**
 * What main.tsx found before the first render (D-56): the survey this iPad is
 * set to, its selection row, the release to show, and the link in the address.
 * `late` when the device's storage did not answer in time, so the default was
 * shown and App must look again.
 */
export interface Startup {
  choice: SurveyChoice;
  row: SelectionRow | undefined;
  release: LoadedRelease | null;
  link: LinkReading;
  late: boolean;
}

/**
 * The built-in release, laid out once. The default survey's floor, and what the
 * screen is drawn from while another survey has nothing to run — never what a
 * sitting of another survey starts under (`loaded` says whether there is one).
 */
let builtInRuntimeMemo: Runtime | null = null;
function builtInRuntime(): Runtime {
  builtInRuntimeMemo ??= buildRuntime(BUILT_IN.manifest, "built-in");
  return builtInRuntimeMemo;
}

/**
 * Where a participant link stands on this iPad (D-56, docs/16 §11.3). Only
 * `checking` and `waiting` stop a sitting from starting: the iPad was given a
 * link to a survey it cannot run yet, and starting the one it is on instead
 * would file a participant into a study nobody meant.
 */
type LinkState =
  | { kind: "none" }
  | { kind: "invalid"; problem: string }
  | { kind: "followed"; choice: SurveyChoice }
  | { kind: "checking"; choice: SurveyChoice }
  | { kind: "waiting"; choice: SurveyChoice; reason: string }
  | { kind: "refused"; choice: SurveyChoice; reason: string };

/** A survey as staff read it on the start screen: ids, which are what a link carries. */
const named = (choice: SurveyChoice) => `the survey “${choice.surveyId}” of the study “${choice.study}”`;

const CLOSED_TO_NEW = "This study is closed, so no new sitting can be started. Please hand the iPad back to the research team.";

export default function App({ initial, initialRuntime }: { initial: Startup; initialRuntime: Runtime | null }) {
  /**
   * Which survey of which study new sittings start on (D-56). Read from the
   * device at start-up; changed only at the start screen, by a link that has
   * proved itself or by staff in the handover panel.
   */
  const [choice, setChoice] = useState<SurveyChoice>(initial.choice);
  const choiceRef = useRef(initial.choice);
  const selectionRow = useRef<SelectionRow | undefined>(initial.row);
  /** The release new sittings start under, or null for a survey not yet on this iPad. */
  const startingRuntime = initialRuntime ?? (isDefaultChoice(initial.choice) ? builtInRuntime() : null);
  const [loaded, setLoaded] = useState(startingRuntime !== null);
  const [link, setLink] = useState<LinkState>({ kind: "none" });
  const linkRef = useRef(link);
  linkRef.current = link;
  /** The link is read once per page; a second run of the start-up effect (StrictMode in development) must not follow it again. */
  const linkHandled = useRef(false);
  /**
   * The release on screen. At the start screen it is the active one; during a
   * resumed sitting it is that sitting's own. Every value below that used to be
   * computed once at module load from the one manifest compiled in is read off
   * it, under the same names.
   *
   * `useScoringDefinitions` is given the scoring of whatever is on screen before
   * it is rendered, here and in `showRuntime`.
   */
  const [runtime, setRuntime] = useState<Runtime>(() => {
    const shown = startingRuntime ?? builtInRuntime();
    useScoringDefinitions(shown.scoring);
    return shown;
  });
  const { manifest, flattened, scaleMap, effort, codeRule, contact, finishScreen, reviewScreen, unitKeyOf, wordsAt } =
    runtime;
  const runtimeRef = useRef(runtime);
  /** The release a new sitting starts under — what the start screen returns to. Null while there is none. */
  const activeRuntime = useRef<Runtime | null>(startingRuntime);
  /**
   * Which sitting a code resumes, and the release to render it with — pinned to
   * the sitting's own release, and only a sitting of the survey the iPad is on.
   * The rule, and its fallback, is `lib/resume.ts`.
   */
  const resumeLookup = useMemo<ResumeLookup>(
    () => ({ find: findResumableSession, releaseForHash: (hash) => serviceFor(choiceRef.current).releaseForHash(hash) }),
    [],
  );
  const showRuntime = useCallback((next: Runtime) => {
    useScoringDefinitions(next.scoring);
    runtimeRef.current = next;
    setRuntime(next);
  }, []);
  /** The last look at the study for a newer release, for the handover panel. */
  const [releaseCheck, setReleaseCheck] = useState<CheckRecord | null>(null);
  /** Set while Start is being handled, so a release arriving then cannot swap under it. */
  const starting = useRef(false);

  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [code, setCode] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [counts, setCounts] = useState<StoredSessionCounts>({
    inProgress: 0,
    completed: 0,
    awaitingSync: 0,
    syncing: 0,
    syncFailed: 0,
    syncedVerified: 0,
    quarantined: 0,
  });
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [device, setDevice] = useState<Enrolment | null>(null);
  // Typed at export and never stored: an iPad that is lost surrenders no way to
  // read the files it wrote.
  const [passphrase, setPassphrase] = useState("");
  /**
   * A write to this device's storage that did not land.
   *
   * THE BUG THIS EXISTS FOR. `record` is called as `void record(...)`, so a
   * rejected write was swallowed: the answer stayed in the in-memory store, "Saved"
   * never appeared, and the participant carried on. On an iPad low on space — or one
   * whose database iOS had evicted under storage pressure — that produced a sitting
   * with gaps that nothing downstream could detect. A dataset missing answers nobody
   * knows are missing is worse than a sitting that stopped.
   *
   * So a failed write stops the survey where it is and asks for a person. The
   * participant sees a calm screen rather than an error, because a child should not
   * be made to feel they broke it.
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [space, setSpace] = useState<Space | null>(null);
  /**
   * Whether this iPad's browser has promised to keep what it is holding, and how long
   * it has been holding it. See `lib/durability.ts`: on an iPad that is not on the
   * Home Screen, WebKit deletes everything after a week of the site not being opened,
   * and a device in a cupboard between school visits is exactly that case.
   */
  const [durability, setDurability] = useState<Durability | null>(null);
  const [heldDays, setHeldDays] = useState<number | null>(null);
  /**
   * Writes that did not land, in the order they were meant to.
   *
   * A QUEUE, NOT ONE WRITE. Keeping only the first failure meant a retry replayed that one
   * and silently abandoned everything after it: a response saved with its timing paradata
   * dropped, or a completion event written without the row that queues the sitting for
   * upload. Each entry is a single Dexie transaction, so it either committed or it did
   * not — which is what makes replaying the list safe rather than a way to duplicate
   * events.
   */
  const unsaved = useRef<(() => Promise<void>)[]>([]);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [accessibility, setAccessibility] = useState<AccessibilityPreferences>(DEFAULT_ACCESSIBILITY_PREFERENCES);
  // Handover is a researcher action on a device that spends its day in
  // participants' hands, so it sits behind a deliberate gesture on the build
  // line rather than a button anyone can find by wandering.
  const handoverTaps = useRef(0);
  const syncBusyRef = useRef(false);
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

  const updateAccessibility = useCallback((patch: Partial<AccessibilityPreferences>) => {
    const next = { ...accessibility, ...patch };
    setAccessibility(next);
    applyAccessibilityPreferences(next);
    void saveAccessibilityPreferences(next);
  }, [accessibility]);

  useEffect(() => {
    let active = true;
    void accessibilityPreferences().then((stored) => {
      if (!active) return;
      setAccessibility(stored);
      applyAccessibilityPreferences(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const refreshDeviceStatus = useCallback(async () => {
    /**
     * The device knows who it is from its own storage, with no network involved.
     * `currentDevice` creates the credential if this is a first launch, so the
     * panel can name the iPad before it has ever reached the study.
     */
    const [stored] = await Promise.all([countStoredSessions(), currentDevice().catch(() => null)]);
    setCounts(stored);
    setDevice(await deviceSummary());
    setSpace(await deviceSpace());
    setDurability(await storageDurability());
    setHeldDays(await heldForDays());
  }, []);

  const runSync = useCallback(
    async (force = false) => {
      if (syncBusyRef.current) return;
      syncBusyRef.current = true;
      setSyncBusy(true);
      try {
        const report = await synchroniseCompletedSessions({ force });
        if (report.outcomes[0]?.kind === "not_configured") {
          setSyncNote("This device has not yet been enrolled for synchronisation.");
        } else if (report.outcomes[0]?.kind === "offline") {
          setSyncNote("This device is offline. Completed sessions remain queued safely on the device.");
        } else if (report.quarantined > 0) {
          setSyncNote(`${report.quarantined} session${report.quarantined === 1 ? " requires" : "s require"} researcher review.`);
        } else if (report.failed > 0) {
          setSyncNote(`${report.failed} session${report.failed === 1 ? " is" : "s are"} queued for a later retry.`);
        } else if (report.synced > 0) {
          setSyncNote(`${report.synced} session${report.synced === 1 ? " was" : "s were"} synchronised and verified.`);
        }
      } finally {
        try {
          await refreshDeviceStatus();
        } finally {
          syncBusyRef.current = false;
          setSyncBusy(false);
        }
      }
    },
    [refreshDeviceStatus],
  );

  useEffect(() => {
    /**
     * Wifi returning is news, so it is acted on rather than waited out.
     *
     * A backoff is a guess about how long a problem will last. A hall whose wifi
     * comes back at 11am makes that guess stale, and a device that had backed off to
     * ten minutes would otherwise sit on working wifi holding a child's answers.
     * So the scheduled waits are dropped and the queue is attempted at once.
     *
     * The attempt count is kept, so an endpoint that is genuinely broken still backs
     * off from where it was rather than restarting at thirty seconds every time a
     * school's access point flaps.
     */
    const on = () => {
      setOnline(true);
      void clearBackoff().then(() => runSync(true));
    };
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, [runSync]);

  useEffect(() => {
    /**
     * Persistence used to be requested here as a bare `void navigator.storage?.persist?.()`
     * on every phase change, with the answer thrown away. That is three problems in one
     * line: nothing ever found out whether the browser agreed, a refusal looked identical
     * to a grant, and on an iPad — where Safari does not implement the method at all — the
     * call was a no-op that read like protection. `refreshDeviceStatus` now goes through
     * `storageDurability`, which asks once per launch, keeps the answer, and reports what
     * to do when there is no promise to be had.
     */
    void refreshDeviceStatus();
  }, [phase.kind, refreshDeviceStatus]);

  /**
   * Keep a new build out until this participant has finished.
   *
   * A service worker taking over reloads the page, and a reload part-way through
   * a questionnaire puts somebody back on the start screen — so an update that
   * arrives mid-sitting waits for the start screen, which is where a device sits
   * between participants anyway.
   */
  useEffect(() => {
    if (phase.kind === "start") updates.release();
    else updates.hold();
  }, [phase.kind]);

  useEffect(() => {
    let live = true;
    void serviceFor(choiceRef.current)
      .activeState()
      .then((state) => {
        if (live && state.lastResult) setReleaseCheck((shown) => shown ?? state.lastResult);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Look for a newer published release, and show it — at the start screen only.
   *
   * Nothing here can hold a participant up: the screen is already showing a
   * release when this runs, the check has its own timeout, and whatever it finds
   * only replaces what is on screen if the device is still at the start screen
   * and nobody is pressing Start. A sitting in progress keeps its release to the
   * end, and a new release takes effect for the next participant.
   */
  const checkRelease = useCallback(async () => {
    const asked = choiceRef.current;
    const service = serviceFor(asked);
    const result = await service.refreshActiveRelease();
    // Moved to another survey while that was in flight: its answer is about a
    // survey this screen is no longer showing.
    if (!sameChoice(asked, choiceRef.current)) return;
    setReleaseCheck(result.record);
    if (result.activeHash !== null && result.activeHash !== activeRuntime.current?.hash) {
      const found = await service.releaseForHash(result.activeHash);
      if (found) {
        try {
          activeRuntime.current = buildRuntime(found.manifest, found.source);
          setLoaded(true);
        } catch {
          // Verification lays a release out before accepting it, so this cannot
          // happen; if it did, the release already running simply carries on.
        }
      }
    }
    if (phaseRef.current.kind !== "start" || starting.current) return;
    if (activeRuntime.current && runtimeRef.current !== activeRuntime.current) showRuntime(activeRuntime.current);
    if (result.record.outcome.kind === "activated") {
      void pruneReleases([runtimeRef.current.hash, ...(activeRuntime.current ? [activeRuntime.current.hash] : [])]);
    }
  }, [showRuntime]);

  /**
   * Show a survey at the start screen: its release from the device, its last
   * check, then a fresh look at the study. Saves nothing — `adopt` decides
   * whether the iPad is moved; this only draws where it now is.
   */
  const switchTo = useCallback(
    async (next: SurveyChoice) => {
      choiceRef.current = next;
      setChoice(next);
      const service = serviceFor(next);
      const release = await service.resolveStartupRelease();
      let shown: Runtime | null = null;
      if (release) {
        try {
          shown = buildRuntime(release.manifest, release.source);
        } catch {
          shown = null;
        }
      }
      if (!shown && isDefaultChoice(next)) shown = builtInRuntime();
      activeRuntime.current = shown;
      setLoaded(shown !== null);
      showRuntime(shown ?? builtInRuntime());
      setReleaseCheck((await service.activeState()).lastResult);
      void checkRelease();
    },
    [showRuntime, checkRelease],
  );

  /** Move this iPad to a survey that has proved itself, and remember it. */
  const adopt = useCallback(
    async (next: SurveyChoice, how: SelectionRow["chosenBy"], followedLink: string | null) => {
      const previous = choiceRef.current;
      const lastLink = followedLink ?? selectionRow.current?.lastLink ?? null;
      await rememberChoice(next, how, previous, lastLink);
      selectionRow.current = (await storedChoice()).row;
      await switchTo(next);
    },
    [switchTo],
  );

  /**
   * Follow a participant link (D-56): check it online, and move the iPad only
   * once it has proved itself. A definite no is said and the iPad stays where
   * it was; a check that could not be made blocks new sittings and is tried
   * again when the network returns, because the iPad was given this survey and
   * running another in its place would file somebody into the wrong study.
   */
  const followLink = useCallback(
    async (target: SurveyChoice) => {
      setLink({ kind: "checking", choice: target });
      const verdict = await checkChoice(target);
      if (verdict.kind === "ready") {
        await adopt(target, "link", choiceKey(target));
        setLink({ kind: "none" });
      } else if (verdict.kind === "refused") {
        setLink({ kind: "refused", choice: target, reason: verdict.reason });
      } else {
        setLink({ kind: "waiting", choice: target, reason: verdict.reason });
      }
    },
    [adopt],
  );

  /**
   * Once, at start-up: settle where the iPad is (if its storage was too slow
   * for the first render), then decide what the link in the address asks for.
   */
  useEffect(() => {
    if (linkHandled.current) return;
    linkHandled.current = true;
    void (async () => {
      let current = choiceRef.current;
      if (initial.late) {
        try {
          const stored = await storedChoice();
          selectionRow.current = stored.row;
          if (!sameChoice(stored.choice, current)) {
            await switchTo(stored.choice);
            current = stored.choice;
          }
        } catch {
          // Storage still not answering: the default carries on, as before.
        }
      }
      const plan = planLink(initial.link, current, selectionRow.current?.lastLink ?? null);
      switch (plan.kind) {
        case "none":
          return;
        case "invalid":
          setLink({ kind: "invalid", problem: plan.problem });
          return;
        case "same":
          if (selectionRow.current?.lastLink !== choiceKey(plan.choice)) {
            await rememberLinkFollowed(current, selectionRow.current, choiceKey(plan.choice)).catch(() => undefined);
            selectionRow.current = (await storedChoice().catch(() => null))?.row ?? selectionRow.current;
          }
          return;
        case "followed":
          setLink({ kind: "followed", choice: plan.choice });
          return;
        case "follow":
          await followLink(plan.choice);
          return;
      }
    })();
    // Once per page: the link is read once, by design (docs/16 §11.3).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On arriving at the start screen (which includes launch and every handover),
  // when the network comes back, and every few minutes while a device waits.
  // A link that could not be checked is tried again at the same moments.
  useEffect(() => {
    if (phase.kind !== "start") return;
    const look = () => {
      void checkRelease();
      const waiting = linkRef.current;
      if (waiting.kind === "waiting") void followLink(waiting.choice);
    };
    look();
    const timer = window.setInterval(look, RELEASE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [phase.kind, online, checkRelease, followLink]);

  useEffect(() => {
    if (online && (phase.kind === "start" || phase.kind === "finished")) void runSync();
  }, [online, phase.kind, runSync]);

  // Safari cannot continue uploads after the PWA closes. While it remains in
  // the foreground, this checks the durable retry deadline once a minute; the
  // queue itself applies exponential back-off and jitter before selecting work.
  useEffect(() => {
    if (!online || !device || (phase.kind !== "start" && phase.kind !== "finished")) return;
    const timer = window.setInterval(() => void runSync(), 60_000);
    return () => window.clearInterval(timer);
  }, [online, phase.kind, runSync, device]);

  /**
   * A copy of the sitting in progress, on the server, every couple of minutes.
   *
   * Otherwise the only sittings the study ever holds are the ones that reached
   * the end, and a dropped iPad or a flat battery halfway through is a morning
   * nobody has a record of.
   *
   * SILENT AND NON-BLOCKING, deliberately. It runs while a child is answering
   * questions, so it never touches the screen, never reports an error, and never
   * moves the sitting out of `in_progress`. A missed checkpoint costs the next
   * attempt and nothing else.
   */
  useEffect(() => {
    if (!online || !device || phase.kind !== "running") return;
    /**
     * Also drains the finished queue, not only the sitting in progress.
     *
     * Otherwise a device that collects back-to-back — which is what a class of
     * thirty looks like — holds every earlier participant's sitting until it next
     * reaches the start screen for long enough. On a morning of continuous
     * handovers that can be the whole morning, and the point of syncing at all is
     * that the study has the data before the iPad leaves the room.
     *
     * Neither call can block the screen: both are fetches with their own timeout,
     * and a failure is silent because a participant answering questions is not the
     * person to tell about an upload.
     */
    /**
     * In sequence, not side by side.
     *
     * They share one lock — both send the same documents, so overlapping them makes a
     * device race itself. Started together, the checkpoint takes the lock synchronously
     * and the drain becomes a permanent no-op: the finished queue would never be sent
     * during a sitting, which is the whole reason this tick does two things. Awaiting the
     * first is what makes the second happen at all.
     */
    const tick = () => {
      void (async () => {
        await checkpointRunningSessions().catch(() => undefined);
        await synchroniseCompletedSessions().catch(() => undefined);
      })();
    };
    // Runs once immediately as well as on the interval: a sitting that begins just
    // after a tick would otherwise wait a whole cadence before the study had any of it.
    tick();
    const timer = window.setInterval(tick, Math.max(1, __CHECKPOINT_SECONDS__) * 1000);
    return () => window.clearInterval(timer);
  }, [online, device, phase.kind]);

  /**
   * And one when the sitting ends, before anything is queued.
   *
   * The gap this closes: a participant who finishes and hands the iPad straight
   * back, on a device that then goes offline for the rest of the day. The
   * ordinary queue covers it eventually; this means the study has the sitting
   * within seconds of it being finished rather than whenever the device next
   * sees a network.
   */
  useEffect(() => {
    if (!online || !device || phase.kind !== "finished") return;
    void checkpointRunningSessions().catch(() => undefined);
  }, [online, device, phase.kind]);

  const runningSession = phase.kind === "running" ? (phase as { session: SessionRow }).session : null;
  const walker = useMemo(
    () =>
      new Walker(
        flattened.units,
        storeRef.current,
        manifest.composition.allowBackNavigation,
        runningSession ? new Date(runningSession.startedAt) : undefined,
      ),
    [runningSession?.sessionId ?? "", runtime],
  );

  /**
   * The sitting's answers as its visible questions hold them: what the review
   * and finish screens pipe from, so an answer to a question a later change
   * hid never turns up in a sentence.
   */
  const visibleAnswers = (session: SessionRow) =>
    new Walker(
      flattened.units,
      storeRef.current,
      manifest.composition.allowBackNavigation,
      new Date(session.startedAt),
    ).visibleAnswers();

  const tMono = () => Math.round(performance.now() - monoStart.current);

  const linkBlocks = link.kind === "checking" || link.kind === "waiting";
  const studyClosed = releaseCheck?.outcome.kind === "study_closed";

  const start = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed.length < 2 || busy) return;
    // Nothing to run, or a link still to be followed: the start screen says
    // why, and offers no Start. Checked here too, so Enter cannot get past it.
    if (!loaded || linkBlocks) return;
    /**
     * The code's format is the ACTIVE release's rule — the one on the start
     * screen, whose instructions and hint the participant is reading — as it
     * always was. A sitting resumed under an older release is found only after
     * this, so a code valid only under an older rule cannot resume; the rule is a
     * study decision, and changing it is expected to be rare.
     */
    if (codeRule && !new RegExp(codeRule.pattern).test(trimmed)) {
      setCodeError(codeRule.hint);
      return;
    }
    setCodeError(null);
    setBusy(true);
    starting.current = true;
    try {
      // `rt` is the release this sitting is rendered and stamped under: the
      // active one for a new sitting, the sitting's own for a resumed one. Read
      // from here down instead of the names above, which are still the start
      // screen's until the next render.
      const { session: existing, runtime: rt } = await sittingToResume(trimmed, runtime, resumeLookup, choiceRef.current);
      // A closed study finishes what it started and starts nothing new (D-56).
      if (!existing && studyClosed) {
        setCodeError(CLOSED_TO_NEW);
        return;
      }
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
        session = await createSession(trimmed, rt.manifest.release.key, rt.manifest.hash ?? "", choiceRef.current);
        await appendEvent(
          session,
          "session.started",
          undefined,
          // The study code is captured here and stored against its variable, so
          // the survey never has to ask for it a second time (D-23).
          { releaseHash: rt.manifest.hash, ...(rt.codeRule?.variable ? { [rt.codeRule.variable]: trimmed } : {}) },
          0,
          tMono(),
        );
      }
      storeRef.current = store;
      skipRun.current = { count: 0, firstIndex: null };
      fastRun.current = 0;
      timing.current = new SessionTiming(rt.effort);
      const w = new Walker(rt.flattened.units, store, rt.manifest.composition.allowBackNavigation, new Date(session.startedAt));
      // A saved position is an index into the sitting's own release, and `rt` is
      // that release: `sittingToResume` only pairs a sitting with its own hash.
      const index = existing ? Math.min(session.currentIndex, rt.flattened.units.length - 1) : (w.first() ?? 0);
      if (existing) {
        await appendEvent(session, "session.resumed", undefined, { resumedAtIndex: index }, index, tMono());
      }
      const firstKey = rt.unitKeyOf(index);
      if (firstKey) {
        const { visit, returning, tooFastMs } = timing.current.enter(firstKey, rt.wordsAt(index));
        void appendEvent(session, "item.presented", firstKey, { visit, returning, tooFastMs }, index, tMono());
      }
      if (rt !== runtimeRef.current) showRuntime(rt);
      // Recorded before the render as well, so a release check finishing in
      // between cannot read a stale "start" and swap this sitting's release.
      const running: Phase = { kind: "running", session, index };
      phaseRef.current = running;
      setPhase(running);
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }, [code, busy, runtime, codeRule, showRuntime, loaded, linkBlocks, studyClosed, resumeLookup]);

  /**
   * Do a write, and stop the survey if it fails.
   *
   * Returns whether it landed, so a caller can decline to advance. A failed write is
   * KEPT, so that "Try again" retries the actual work rather than just clearing the
   * message — a retry that dismissed the warning without saving anything would be the
   * same silent loss with an extra step.
   *
   * Anything that arrives while something is already waiting joins the queue rather than
   * being attempted, so a retry can never reorder a log.
   */
  const persist = useCallback(async (write: () => Promise<void>): Promise<boolean> => {
    if (unsaved.current.length > 0) {
      unsaved.current.push(write);
      return false;
    }
    try {
      await write();
      setSaveError(null);
      return true;
    } catch (error) {
      unsaved.current = [write];
      setSaveError(
        error instanceof Error && /quota|storage|space/i.test(error.message)
          ? "This iPad has run out of space to save answers."
          : "This iPad could not save that answer.",
      );
      return false;
    }
  }, []);

  /**
   * Replay everything waiting, in order, stopping at the first that still fails.
   *
   * Retrying one write and abandoning the rest was its own kind of silent loss: a
   * response saved with its timing paradata dropped, or a completion event written
   * without the row that queues the sitting for upload. Each entry is a single Dexie
   * transaction — it either committed or it did not — which is what makes replaying the
   * list safe rather than a way to duplicate events.
   */
  const retrySave = useCallback(() => {
    void (async () => {
      while (unsaved.current.length > 0) {
        try {
          await unsaved.current[0]!();
        } catch {
          // Still failing. Leave it, and everything behind it, where they are.
          return;
        }
        unsaved.current.shift();
      }
      setSaveError(null);
    })();
  }, []);

  const record = useCallback(
    async (unit: PresentableUnit, value: AnswerValue) => {
      if (phase.kind !== "running") return;
      const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
      const itemKey = `${unit.instrument}.${unit.item.key}`;
      const had = storeRef.current.get(ref)?.status === "answered";
      storeRef.current.set(ref, { status: "answered", value });
      bumpAnswers();
      const t = timing.current.recordResponse(itemKey, had);
      /**
       * ONE WRITE PER `persist`, and the reason is the retry.
       *
       * A closure containing two writes can half-succeed: the response lands, the
       * paradata does not, and "Try again" re-runs both — appending the answer a second
       * time and double-counting the pace run. `appendEvent` is a Dexie transaction, so a
       * single write either commits or does not, which makes retrying exactly one of them
       * safe.
       *
       * The counter is also moved out of the closure, so a retry cannot advance it twice.
       */
      const landed = await persist(() =>
        appendEvent(
          phase.session,
          had ? "response.changed" : "response.recorded",
          itemKey,
          // Timing rides with the response so a single event carries both what
          // was answered and how long it took to answer it.
          { value, timing: t },
          phase.index,
          tMono(),
        ),
      );
      if (!landed) return;

      // The answer stands either way — this only records that it arrived faster than the
      // question could have been read. Paradata rather than an answer, so a failure here
      // is worth reporting but the response above is already safely stored.
      if (t.tooFast) {
        fastRun.current += 1;
        const run = fastRun.current;
        if (
          !(await persist(() =>
            appendEvent(
              phase.session,
              "response.too_fast",
              itemKey,
              { sinceShownMs: t.sinceShownMs, thresholdMs: t.thresholdMs, run },
              phase.index,
              tMono(),
            ),
          ))
        ) {
          return;
        }
      } else {
        fastRun.current = 0;
      }
      setSavedAt(new Date().toLocaleTimeString());
    },
    [phase, persist],
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
    [phase, runtime],
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
    [phase, runtime],
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
    [phase, runtime],
  );

  const advance = useCallback(
    async (from: number, kind: "next" | "skip" | "decline") => {
      if (phase.kind !== "running") return;
      /**
       * Never walk past an answer that did not save.
       *
       * Without this the participant could carry on from the screen that failed, and
       * the sitting would be missing exactly the answer nobody was told about.
       */
      if (saveError) return;
      const unit = flattened.units[from];
      if (unit && (kind === "skip" || kind === "decline")) {
        const ref = { instrument: unit.instrument, item: unit.item.key, revision: unit.item.revision };
        storeRef.current.set(ref, { status: kind === "skip" ? "skipped" : "declined" });
        bumpAnswers();
        const landed = await persist(() =>
          appendEvent(
            phase.session,
            kind === "skip" ? "item.skipped" : "item.declined",
            `${unit.instrument}.${unit.item.key}`,
            undefined,
            from,
            tMono(),
          ),
        );
        if (!landed) return;
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

      const w = new Walker(
        flattened.units,
        storeRef.current,
        manifest.composition.allowBackNavigation,
        new Date(phase.session.startedAt),
      );
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
        /**
         * The last question leads to "you've finished" — not to a wall of everything they
         * just answered. The review is offered there, for the minority who know they got
         * something wrong (D-31).
         *
         * THROUGH `persist`, LIKE EVERY OTHER WRITE. These two were the last ones that
         * were not, and they are the worst pair to lose: `completeSession` is what moves
         * a sitting into the upload queue, so a silent failure here left a finished
         * sitting stuck `in_progress`, never queued, never uploaded, and the participant
         * looking at a thank-you screen.
         */
        // Two writes, two `persist` calls: one closure containing both would, on a retry
        // after a partial failure, append a second `session.completed` with a second
        // timing summary.
        const wrote = await persist(() =>
          appendEvent(phase.session, "session.completed", undefined, timing.current.summary(), from, tMono()),
        );
        if (!wrote) return;
        if (!(await persist(() => completeSession(phase.session)))) return;
        setPhase({ kind: "finished", session: phase.session });
      } else {
        void enterItem(next);
        setPhase({ kind: "running", session: phase.session, index: next });
      }
    },
    [phase, persist, saveError, runtime],
  );

  const goBack = useCallback(
    async (from: number) => {
      if (phase.kind !== "running") return;
      /**
       * Editing one answer from the summary: "Back" returns to the summary.
       *
       * THE BUG THIS FIXES. A participant who has finished can open the summary,
       * tap a question to change it, and land back on that question with
       * `fromReview` set — so pressing Next returns them to the summary. But
       * pressing Back rebuilt the running phase WITHOUT `fromReview`, dropping
       * them into the ordinary survey with no way back to the end except walking
       * every remaining question again. From the summary you came, so to the
       * summary Back goes.
       */
      if (phase.fromReview) {
        await leaveItem(from, false);
        await appendEvent(phase.session, "review.returned", unitKeyOf(from), undefined, from, tMono());
        setPhase({ kind: "review", session: phase.session });
        return;
      }
      const w = new Walker(
        flattened.units,
        storeRef.current,
        manifest.composition.allowBackNavigation,
        new Date(phase.session.startedAt),
      );
      const prev = w.back(from);
      if (prev !== null) {
        await leaveItem(from, false);
        await appendEvent(phase.session, "navigation.back", undefined, { from, to: prev }, prev, tMono());
        enterItem(prev);
        setPhase({ kind: "running", session: phase.session, index: prev });
      }
    },
    [phase, runtime],
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
    // Back to the release new sittings start under, straight away and from what
    // this device already holds — a resumed sitting may have been shown under an
    // older one. The start screen then asks the study whether anything is newer.
    if (activeRuntime.current && runtimeRef.current !== activeRuntime.current) showRuntime(activeRuntime.current);
    setPhase({ kind: "start" });
  }, [effort, showRuntime]);

  /** The handover panel's "Check": what typed text names, and whether this iPad can run it (D-56). */
  const checkTypedSurvey = useCallback(async (text: string): Promise<PanelCheck> => {
    const reading = readTypedChoice(text, DEFAULT_CHOICE.study);
    if (reading.kind === "none") return { kind: "invalid", problem: "paste a participant link, or type study/survey" };
    if (reading.kind === "invalid") return reading;
    if (sameChoice(reading.choice, choiceRef.current)) return { kind: "same" };
    const verdict = await checkChoice(reading.choice);
    if (verdict.kind !== "ready") return verdict;
    return {
      kind: "ready",
      choice: reading.choice,
      title: verdict.title,
      version: verdict.version,
      leftBehind: await unfinishedElsewhere(reading.choice).catch(() => 0),
    };
  }, []);

  /** The handover panel's confirmed "Use this survey on this iPad". */
  const useSurvey = useCallback(
    async (next: SurveyChoice) => {
      if (phaseRef.current.kind !== "start") return;
      await adopt(next, "staff", null);
      setLink({ kind: "none" });
    },
    [adopt],
  );

  /**
   * What the start screen says to staff about the survey (D-56), and whether it
   * stands in for the code and Start: a link not yet followed, or a survey with
   * nothing on this iPad to run.
   */
  const startNotice = useMemo<StartNotice | null>(() => {
    const here = named(choice);
    switch (link.kind) {
      case "checking":
        return { blocking: true, text: `This iPad has been given a link to ${named(link.choice)}. Checking it and downloading it now…` };
      case "waiting":
        return {
          blocking: true,
          text: `This iPad has been given a link to ${named(link.choice)}. It has to be downloaded once, and ${link.reason}. Connect this iPad to the internet: it will try again by itself.`,
        };
      case "refused":
        return {
          blocking: false,
          text: `The link to ${named(link.choice)} can't be used: ${link.reason}. This iPad stays on ${here}.`,
          dismiss: () => setLink({ kind: "none" }),
        };
      case "invalid":
        return {
          blocking: false,
          text: `This link isn't one MySelf can use: ${link.problem}. This iPad stays on ${here}.`,
          dismiss: () => setLink({ kind: "none" }),
        };
      case "followed":
        return {
          blocking: false,
          text: `This iPad was set up from this link before and has been moved since: it is on ${here}. Staff can change it in the handover panel.`,
          dismiss: () => setLink({ kind: "none" }),
        };
      case "none":
        break;
    }
    if (!loaded) {
      const verdict = releaseCheck ? verdictOf(releaseCheck.outcome, false) : null;
      const why = verdict?.kind === "refused" ? ` The last check found that ${verdict.reason}.` : "";
      return {
        blocking: true,
        text: `This iPad is set to ${here}, which is not on this iPad yet. Connect it to the internet: it will download by itself.${why} Staff can move the iPad back to the default survey in the handover panel.`,
      };
    }
    if (studyClosed) return { blocking: false, text: "This study is closed. An unfinished sitting can still be finished; no new one can start." };
    return null;
  }, [choice, link, loaded, releaseCheck, studyClosed]);

  return (
    <div className="app">
      <div className="status-strip" aria-live="polite">
        <span className={`dot ${online ? "online" : "offline"}`} />
        <span className="status-text">{online ? "Online" : "Offline — everything is saved on this device"}</span>
        {savedAt && phase.kind === "running" && <span className="saved">Saved ✓</span>}
      </div>

      {phase.kind === "start" && (
        <StartScreen
          notice={startNotice}
          surveyLabel={isDefaultChoice(choice) ? null : `${choice.study}/${choice.surveyId}`}
          studyLabel={manifest.composition.studyLabel}
          codeRule={codeRule}
          contact={contact}
          releaseVersion={manifest.release.version}
          releaseHash={manifest.hash}
          releaseBuiltIn={runtime.source === "built-in"}
          code={code}
          codeError={codeError}
          onCodeChange={setCode}
          onCodeErrorClear={() => setCodeError(null)}
          busy={busy}
          onStart={start}
          accessibility={accessibility}
          onAccessibilityChange={updateAccessibility}
          durability={durability}
          counts={counts}
          onBuildLineTap={() => {
            handoverTaps.current += 1;
            if (handoverTaps.current >= 5) {
              handoverTaps.current = 0;
              setHandoverOpen((v) => !v);
            }
          }}
        >
          {handoverOpen && (
            <HandoverPanel
              counts={counts}
              space={space}
              durability={durability}
              heldDays={heldDays}
              online={online}
              syncBusy={syncBusy}
              onSync={() => void runSync(true)}
              device={device}
              passphrase={passphrase}
              onPassphraseChange={setPassphrase}
              onNote={setHandoverNote}
              onCleared={refreshDeviceStatus}
              onSittingsErased={async () => {
                await pruneReleases([runtimeRef.current.hash, ...(activeRuntime.current ? [activeRuntime.current.hash] : [])]);
              }}
              survey={{ choice, isDefault: isDefaultChoice(choice), defaultChoice: DEFAULT_CHOICE }}
              onCheckSurvey={checkTypedSurvey}
              onUseSurvey={useSurvey}
              releaseNote={
                (loaded
                  ? `New sittings use release ${manifest.release.version} (${manifest.hash?.slice(7, 19)}), ` +
                    (runtime.source === "built-in"
                      ? "the version built into this app."
                      : runtime.source === "live"
                        ? "downloaded from the study and verified since the app was opened."
                        : "downloaded from the study earlier and verified on this device.")
                  : "This survey is not on this iPad yet, so no sitting can start.") +
                " " +
                (releaseCheck
                  ? `Last checked ${new Date(releaseCheck.at).toLocaleTimeString()}: ${describeCheck(releaseCheck.outcome, isDefaultChoice(choice))}`
                  : "Not yet checked for a newer version.")
              }
              syncNote={syncNote}
              handoverNote={handoverNote}
            />
          )}
        </StartScreen>
      )}

      {/*
        A write that did not land, in front of everything else.
        Calm on purpose: a child should not be made to feel they broke it, and the
        one thing that must not happen is carrying on as though the answer was saved.
        `advance` refuses while this is up, so the survey cannot be walked past it.
      */}
      {saveError && <SaveFailedScreen message={saveError} onRetry={retrySave} />}

      {phase.kind === "running" && !saveError && (
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
          narrative={{
            // The sitting's own id is the whole join: the module stores its
            // run against it, the sitting is stored against it, and the export
            // puts the conversation beside the questionnaire because the two
            // agree about who this was.
            moduleUrl: __MYSTORY_URL__ || null,
            sessionId: phase.session.sessionId,
            releaseHash: manifest.hash ?? "",
            // The sitting's own study (D-56), which the module acts in.
            study: phase.session.study ?? DEFAULT_CHOICE.study,
            // The frozen protocols, sent to the module so it runs exactly what
            // this version published, which Studio may have edited.
            protocols: manifest.narrativeProtocols,
            // This iPad's own credential, which the module calls the model with
            // under its daily limits (D-55). Sent by message, never in the URL.
            credential: () => syncTarget().then(moduleCredential),
          }}
          onRecord={(u, v) => void record(u, v)}
          onAdvance={(f, k) => void advance(f, k)}
          onBack={(f) => void goBack(f)}
          onEvent={emit}
          reviewEdit={phase.fromReview === true}
        />
      )}

      {phase.kind === "pace" && (
        <PaceScreen
          onCarryOn={() => {
            enterItem(phase.index);
            setPhase({ kind: "running", session: phase.session, index: phase.index });
          }}
        />
      )}

      {phase.kind === "checkin" && (
        <CheckInScreen
          onGoBack={() => {
            void appendEvent(phase.session, "effort.checkin_returned", undefined, { to: phase.firstSkipped }, phase.firstSkipped, tMono());
            enterItem(phase.firstSkipped);
            setPhase({ kind: "running", session: phase.session, index: phase.firstSkipped });
          }}
          onKeepGoing={() => {
            enterItem(phase.index);
            setPhase({ kind: "running", session: phase.session, index: phase.index });
          }}
        />
      )}

      {phase.kind === "review" && reviewScreen && (
        <ReviewScreen
          units={flattened.units}
          scales={scaleMap}
          store={storeRef.current}
          allowBack={manifest.composition.allowBackNavigation}
          sectionTitles={flattened.sectionTitles}
          sessionStart={new Date(phase.session.startedAt)}
          title={reviewScreen.title ? resolveText(reviewScreen.title.text, reviewScreen.title.pipes, visibleAnswers(phase.session), new Date(phase.session.startedAt)) : "Change an answer"}
          body={resolveText(reviewScreen.body.text, reviewScreen.body.pipes, visibleAnswers(phase.session), new Date(phase.session.startedAt))}
          onEdit={(index) => {
            void appendEvent(phase.session, "review.opened", unitKeyOf(index), { editing: true }, index, tMono());
            const key = unitKeyOf(index);
            if (key) timing.current.enter(key, wordsAt(index));
            setPhase({ kind: "running", session: phase.session, index, fromReview: true });
          }}
          onFinish={() => {
            void (async () => {
              // Coming back from a change re-completes the session, so the completion
              // event always follows the last edit in the log. Through `persist` for the
              // same reason as the other completion path: this is the write that queues
              // the sitting for upload.
              const wrote = await persist(() =>
                appendEvent(phase.session, "session.completed", undefined, timing.current.summary(), 0, tMono()),
              );
              if (!wrote) return;
              if (await persist(() => completeSession(phase.session))) {
                setPhase({ kind: "finished", session: phase.session });
              }
            })();
          }}
        />
      )}

      {phase.kind === "finished" && (
        <FinishScreen
          // The name given at the very start, used at the very end. Both the
          // title and the body are piped like any other participant text, so
          // this is a release decision rather than something coded here.
          title={
            finishScreen?.title
              ? resolveText(finishScreen.title.text, finishScreen.title.pipes, visibleAnswers(phase.session), new Date(phase.session.startedAt))
              : "Thank you!"
          }
          body={
            finishScreen
              ? resolveText(finishScreen.body.text, finishScreen.body.pipes, visibleAnswers(phase.session), new Date(phase.session.startedAt))
              : "You've finished — thank you."
          }
          onReview={
            reviewScreen
              ? () => {
                  void appendEvent(phase.session, "review.opened", undefined, { from: "finish" }, 0, tMono());
                  setPhase({ kind: "review", session: phase.session });
                }
              : undefined
          }
          onHandBack={handover}
        />
      )}
    </div>
  );
}
