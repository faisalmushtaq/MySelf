import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefCallback } from "react";
import type { PresentableUnit } from "@myself/engine";
import { responseScale, type ReleaseManifest, type ResponseScale } from "@myself/schema";
import { previewRelease, type StudioDraft } from "@myself/studio";
import { flattenManifest, type FlattenedRelease } from "@participant/lib/flatten.js";
import { Button, EmptyState, Notice, Segmented, Skeleton } from "../ui/kit.js";
import { Icon, type IconName } from "../ui/icons.js";
import { describeCondition, type DescribeContext } from "./model-adapter.js";
import {
  pathEntries,
  problemParts,
  restartPoint,
  sectionRuns,
  shorten,
  unitKeyOf,
  unitLabel,
  type PathEntry,
  type PathState,
} from "./path.js";
import {
  fingerprint,
  fromExpected,
  isReady,
  MSG_GOTO,
  MSG_LOAD,
  newNonce,
  parseState,
  START_FINISH,
  START_REVIEW,
  type GotoMessage,
  type LoadMessage,
  type StartAt,
  type StateMessage,
} from "./protocol.js";
import "../studio.css";
import "./preview.css";

/**
 * Preview — the current draft, exactly as a participant would meet it
 * (docs/16 §5.6, risk R7).
 *
 * The draft is compiled here with the same gate the server publishes through,
 * then handed to an isolated frame (preview.html) that runs it on the
 * participant app's own screens with an in-memory answer store. Nothing a
 * researcher does in the frame is written anywhere, and the banner says so.
 *
 * Around the frame: device sizes (the frame is given the device's real CSS
 * size, so the participant's own layout rules apply, and scaled down to fit),
 * restart and "start from", and the path — every screen in order, with what
 * has been answered and what a condition is hiding, and why.
 */

export interface PreviewPageProps {
  surveyId: string;
  draft: StudioDraft | null;
  /** Open the preview at this question ("finish", "review", or null for the start screen). */
  startAt?: string | null;
}

type Device = "desktop" | "tablet" | "phone";

const DEVICES: Record<Device, { label: string; width: number; height: number; icon: IconName }> = {
  desktop: { label: "Desktop", width: 1280, height: 800, icon: "desktop" },
  tablet: { label: "Tablet", width: 820, height: 1180, icon: "tablet" },
  phone: { label: "Phone", width: 390, height: 844, icon: "phone" },
};

/** Space kept around the device inside the stage, and for its caption. */
const STAGE_PAD = 24;
const CAPTION = 34;

/** Wait this long after the last edit before recompiling, so typing stays smooth. */
const RECOMPILE_MS = 350;

interface Compiled {
  manifest: ReleaseManifest | null;
  /** Publish-gate refusals: shown, but the survey still runs. */
  failures: string[];
  /** Set when there is nothing to run: the schema's complaints, one per line. */
  error: string | null;
  flattened: FlattenedRelease | null;
  scales: Map<string, ResponseScale>;
  fingerprint: string | null;
}

function compile(draft: StudioDraft): Compiled {
  const empty = { flattened: null, scales: new Map<string, ResponseScale>(), fingerprint: null };
  const release = previewRelease(draft);
  if (!release.manifest) {
    return { ...empty, manifest: null, failures: release.failures, error: release.error ?? "The draft could not be compiled." };
  }
  let flattened: FlattenedRelease;
  try {
    flattened = flattenManifest(release.manifest);
  } catch (error) {
    // The participant app throws on these too, at start-up: a placement whose
    // questions or instrument the release does not carry.
    return {
      ...empty,
      manifest: null,
      failures: release.failures,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const scales = new Map<string, ResponseScale>();
  for (const [key, raw] of Object.entries(release.manifest.scales)) {
    const parsed = responseScale.safeParse(raw);
    if (parsed.success) scales.set(key, parsed.data);
  }
  return {
    manifest: release.manifest,
    failures: release.failures,
    error: null,
    flattened,
    scales,
    fingerprint: fingerprint(release.manifest),
  };
}

/** The draft to compile: the first at once, later ones once editing pauses. */
function useSettledDraft(draft: StudioDraft | null): StudioDraft | null {
  const [settled, setSettled] = useState(draft);
  useEffect(() => {
    if (draft === null || settled === null) {
      setSettled(draft);
      return;
    }
    if (draft === settled) return;
    const timer = window.setTimeout(() => setSettled(draft), RECOMPILE_MS);
    return () => window.clearTimeout(timer);
    // `settled` is read, not reacted to: only a new draft starts the wait.
  }, [draft]);
  return settled;
}

/** The size of an element, kept current as the window or panes are resized. */
function useSize<T extends HTMLElement>(): [RefCallback<T>, { width: number; height: number } | null] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size];
}

export function PreviewPage({ surveyId, draft, startAt = null }: PreviewPageProps) {
  const settled = useSettledDraft(draft);
  const compiled = useMemo(() => (settled ? compile(settled) : null), [settled]);
  const title = settled?.composition.title || surveyId;
  // Held here rather than beside the frame, so a draft that is briefly
  // unpreviewable mid-edit does not also lose the researcher's device and
  // starting point when it comes back.
  const [device, setDevice] = useState<Device>("tablet");
  const [chosenStart, setChosenStart] = useState<StartAt>(startAt);
  const firstStartAt = useRef(true);
  useEffect(() => {
    // A new starting point from the host — the question selected in the editor.
    if (firstStartAt.current) {
      firstStartAt.current = false;
      return;
    }
    setChosenStart(startAt);
  }, [startAt]);

  if (!compiled) {
    return (
      <section className="st-pv" aria-label="Participant preview">
        <PreviewBanner announcement={null} />
        {draft ? (
          <div className="st-pv-blocked">
            <Skeleton lines={4} label="Preparing the preview" />
          </div>
        ) : (
          <EmptyState icon="eye" title="Nothing to preview yet">
            When the survey&apos;s draft has loaded, it appears here exactly as a participant would meet it.
          </EmptyState>
        )}
      </section>
    );
  }

  if (compiled.error || !compiled.manifest || !compiled.flattened || !compiled.fingerprint) {
    return (
      <section className="st-pv" aria-label="Participant preview">
        <PreviewBanner announcement={null} />
        <div className="st-pv-blocked">
          <Notice tone="error" title="This draft can't be previewed yet">
            <p className="st-pv-p">
              Part of the survey isn&apos;t in a shape the participant app can read, so there is nothing to show.
              Fix what is listed here and the preview will appear.
            </p>
            <ProblemList lines={(compiled.error ?? "The draft could not be compiled.").split("\n")} schema />
          </Notice>
        </div>
      </section>
    );
  }

  return (
    <LivePreview
      title={title}
      manifest={compiled.manifest}
      flattened={compiled.flattened}
      scales={compiled.scales}
      failures={compiled.failures}
      fingerprintOf={compiled.fingerprint}
      device={device}
      onDevice={setDevice}
      chosenStart={chosenStart}
      onChooseStart={setChosenStart}
    />
  );
}

function LivePreview({
  title,
  manifest,
  flattened,
  scales,
  failures,
  fingerprintOf,
  device,
  onDevice,
  chosenStart,
  onChooseStart,
}: {
  title: string;
  manifest: ReleaseManifest;
  flattened: FlattenedRelease;
  scales: Map<string, ResponseScale>;
  failures: string[];
  fingerprintOf: string;
  device: Device;
  onDevice: (device: Device) => void;
  chosenStart: StartAt;
  onChooseStart: (start: StartAt) => void;
}) {
  const units = flattened.units;
  const hasReview = manifest.composition.screens["review"] !== undefined;
  const [state, setState] = useState<StateMessage | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(0);
  const [stageRef, stage] = useSize<HTMLDivElement>();

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** The load the frame is running: replies with any other nonce are stale. */
  const loaded = useRef<{ nonce: string; fingerprint: string } | null>(null);
  const latest = useRef({ manifest, fingerprintOf, state, chosenStart });
  latest.current = { manifest, fingerprintOf, state, chosenStart };

  const instrumentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const def of Object.values(manifest.instruments) as { instrument?: string; name?: string }[]) {
      if (def.instrument && def.name) names.set(def.instrument, def.name);
    }
    return names;
  }, [manifest]);
  const labels = useMemo(() => units.map((u) => unitLabel(u, instrumentNames)), [units, instrumentNames]);
  const runs = useMemo(() => sectionRuns(units, flattened.sectionTitles), [units, flattened]);
  const unitKeys = useMemo(() => new Set(units.map(unitKeyOf)), [units]);

  // The pending announcement, so a newer one replaces it and unmounting (the
  // draft turning unpreviewable, say) cancels it rather than setting state on
  // a component that has gone.
  const announceTimer = useRef<number | null>(null);
  const announce = useCallback((message: string) => {
    // Cleared first so the same words twice are still announced twice.
    setAnnouncement(null);
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => {
      announceTimer.current = null;
      setAnnouncement(message);
    }, 30);
  }, []);
  useEffect(
    () => () => {
      if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  /** Start the frame over on the current release. */
  const load = useCallback((start: StartAt) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;
    const { manifest: m, fingerprintOf: f } = latest.current;
    const nonce = newNonce();
    loaded.current = { nonce, fingerprint: f };
    setState(null);
    const message: LoadMessage = { type: MSG_LOAD, nonce, manifest: m, startAt: start };
    frame.postMessage(message, window.location.origin);
  }, []);

  // Listen to the frame, and only the frame. A layout effect, so the listener
  // is in place in the same commit that creates the iframe — before the
  // frame's document can possibly have loaded and said it is ready.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow ?? null;
      if (!fromExpected(event, { origin: window.location.origin, source: frame })) return;
      if (isReady(event.data)) {
        // A new document in the frame: whatever it was running has gone.
        loaded.current = null;
        setFrameReady((n) => n + 1);
        return;
      }
      const next = parseState(event.data);
      if (next && next.nonce === loaded.current?.nonce) setState(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Load when the frame is ready, and reload when — only when — what a
  // participant would see has changed. A save that changes nothing a
  // participant meets (a coding note, say) leaves the run alone.
  useEffect(() => {
    if (frameReady === 0) return;
    const current = loaded.current;
    if (current && current.fingerprint === fingerprintOf) return;
    if (!current) {
      load(latest.current.chosenStart);
      return;
    }
    // Where the run was; `undefined` when that is not known (see restartPoint).
    const here = restartPoint(latest.current.state, unitKeys);
    load(here === undefined ? latest.current.chosenStart : here);
    announce(
      here === null
        ? "The draft changed, so the preview reloaded on the start screen."
        : here !== undefined
          ? "The draft changed, so the preview restarted on the same screen. Answers given so far were cleared."
          : "The draft changed, so the preview restarted.",
    );
  }, [frameReady, fingerprintOf, load, announce, unitKeys]);

  const startLabel = (start: StartAt): string => {
    if (!start) return "the start screen";
    if (start === START_FINISH) return "the completion screen";
    if (start === START_REVIEW) return "the review screen";
    const index = units.findIndex((u) => unitKeyOf(u) === start);
    return index < 0 ? "the start screen" : `“${shorten(labels[index] ?? start, 60)}”`;
  };

  // A new starting point — chosen from the list, or sent by the host — starts
  // the run over there. Not on mount: the frame's first load does that.
  const firstChoice = useRef(true);
  useEffect(() => {
    if (firstChoice.current) {
      firstChoice.current = false;
      return;
    }
    if (!loaded.current) return;
    load(chosenStart);
    announce(`Preview restarted from ${startLabel(chosenStart)}.`);
  }, [chosenStart, load]);

  const jump = useCallback((target: string) => {
    const frame = iframeRef.current?.contentWindow;
    const current = loaded.current;
    if (!frame || !current) return;
    const message: GotoMessage = { type: MSG_GOTO, nonce: current.nonce, target };
    frame.postMessage(message, window.location.origin);
  }, []);

  const spec = DEVICES[device];
  const scale = stage
    ? Math.max(
        0.15,
        Math.min(1, (stage.width - STAGE_PAD * 2) / spec.width, (stage.height - STAGE_PAD * 2 - CAPTION) / spec.height),
      )
    : 0.5;
  const percent = Math.round(scale * 100);
  const entries = useMemo(() => pathEntries(units, state), [units, state]);
  const selectValue = chosenStart && (chosenStart === START_FINISH || chosenStart === START_REVIEW || unitKeys.has(chosenStart)) ? chosenStart : "";
  const startId = useId();

  return (
    <section className="st-pv" aria-label={`Participant preview of ${title}`}>
      <div className="st-pv-toolbar">
        <Segmented<Device>
          label="Device size"
          value={device}
          onChange={onDevice}
          options={(Object.keys(DEVICES) as Device[]).map((d) => ({ value: d, label: DEVICES[d].label, icon: DEVICES[d].icon }))}
        />
        <Button
          icon="restart"
          size="sm"
          onClick={() => {
            load(chosenStart);
            announce(`Preview restarted from ${startLabel(chosenStart)}.`);
          }}
        >
          Restart
        </Button>
        <div className="st-pv-startfrom">
          <label htmlFor={startId}>Start from</label>
          <select
            id={startId}
            className="st-select"
            value={selectValue}
            onChange={(e) => onChooseStart(e.target.value || null)}
          >
            <option value="">The start screen</option>
            {runs.map((run) => (
              <optgroup key={`${run.sectionKey}-${run.indices[0]}`} label={run.title}>
                {run.indices.map((i) => (
                  <option key={i} value={unitKeyOf(units[i]!)}>
                    {labels[i]}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="End of the survey">
              <option value={START_FINISH}>Completion screen</option>
              {hasReview ? <option value={START_REVIEW}>Review screen</option> : null}
            </optgroup>
          </select>
        </div>
        <span className="st-pv-scale">
          {spec.width} × {spec.height} · {percent}%
        </span>
      </div>

      <PreviewBanner announcement={announcement} />

      {failures.length > 0 || state?.phase === "error" ? (
        <div className="st-pv-notices">
          {state?.phase === "error" ? (
            <Notice tone="error" title="The preview couldn't run this draft">
              <ProblemList lines={(state.error ?? "").split("\n")} schema />
            </Notice>
          ) : null}
          {failures.length > 0 ? (
            <Notice tone="warn" title="Publishing will be refused until these are fixed">
              <p className="st-pv-p">
                {failures.length === 1 ? "One problem" : `${failures.length} problems`}. The preview still runs, so you
                can see the effect of each.
              </p>
              <ProblemList lines={failures} initial={2} />
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div className="st-pv-body">
        <div className="st-pv-stage" ref={stageRef}>
          <figure className={`st-pv-device st-pv-device-${device}`}>
            <div className="st-pv-screen" style={{ width: Math.round(spec.width * scale), height: Math.round(spec.height * scale) }}>
              <iframe
                ref={iframeRef}
                src={`${import.meta.env.BASE_URL}preview.html`}
                title={`Participant preview of ${title}, at ${spec.label.toLowerCase()} size`}
                // Our own page, on our own origin — the frame and the Studio
                // check each other's messages by origin. The sandbox is for
                // what the page must not do: navigate the Studio away from
                // unsaved work, open windows or submit forms.
                sandbox="allow-scripts allow-same-origin"
                width={spec.width}
                height={spec.height}
                style={{ transform: `scale(${scale})` }}
              />
            </div>
            <figcaption className="st-pv-caption">
              {spec.label}, {spec.width} × {spec.height} pixels, shown at {percent}%
            </figcaption>
          </figure>
        </div>
        <PathPanel
          units={units}
          runs={runs}
          labels={labels}
          entries={entries}
          scales={scales}
          state={state}
          onJump={jump}
        />
      </div>
    </section>
  );
}

/** The promise the preview makes, on screen the whole time, and any news about the run. */
function PreviewBanner({ announcement }: { announcement: string | null }) {
  return (
    <div className="st-pv-banner">
      <Icon name="lock" size={16} />
      <p>
        <strong>Preview</strong> — answers stay in this tab and are never saved or sent.
      </p>
      <p className="st-pv-announce" role="status">
        {announcement ? (
          <>
            <Icon name="info" size={14} /> {announcement}
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Problems one per line; schema lines split into the field and what is wrong
 * with it. The first few are shown and the rest are a click away, so a long
 * list never pushes the preview itself off the screen.
 */
function ProblemList({ lines, schema = false, initial = 8 }: { lines: string[]; schema?: boolean; initial?: number }) {
  const shown = lines.filter((l) => l.trim().length > 0);
  const first = shown.slice(0, initial);
  const rest = shown.slice(initial);
  const row = (line: string, i: number) => {
    // Only a real field path is set as code; see problemParts.
    const { path, message } = schema ? problemParts(line) : { path: null, message: line };
    return (
      <li key={i}>
        {path !== null ? (
          <>
            <code className="st-pv-path-code">{path}</code> {message}
          </>
        ) : (
          line
        )}
      </li>
    );
  };
  return (
    <>
      <ul className="st-pv-problems">{first.map(row)}</ul>
      {rest.length > 0 ? (
        <details className="st-pv-more">
          <summary>
            Show {rest.length} more {rest.length === 1 ? "problem" : "problems"}
          </summary>
          <ul className="st-pv-problems">{rest.map((l, i) => row(l, i + first.length))}</ul>
        </details>
      ) : null}
    </>
  );
}

const STATE_ICON: Record<PathState, IconName | null> = {
  current: "play",
  answered: "check",
  shown: "eye",
  hidden: "eye-off",
  // An empty ring: nothing has happened here yet, and the words say so.
  not_reached: null,
};

/** A row's state in words — the icon and colour only repeat this. */
function stateText(entry: PathEntry): string {
  const answer = entry.answer === null ? "" : `Answer: ${entry.answer}`;
  switch (entry.state) {
    case "current":
      return answer ? `On screen now · ${answer}` : "On screen now";
    case "answered":
      return answer;
    case "shown":
      return "Seen";
    case "hidden":
      // An answer given before a later change hid the question is still held.
      return answer ? `Hidden · ${answer}` : "Hidden";
    case "not_reached":
      return "Not reached yet";
  }
}

/** Why a row is hidden: its condition, and where the answers it reads stand now. */
function whyHidden(unit: PresentableUnit, entry: PathEntry, ctx: DescribeContext): string[] {
  if (!unit.displayIf) return [];
  const lines = [`Shown only when ${describeCondition(unit.displayIf, ctx)}.`];
  if (entry.drivers.length > 0) {
    if (entry.drivers.every((d) => d.answer === null)) {
      lines.push(`Waiting for an answer to ${entry.drivers.map((d) => ctx.questionLabel(d.itemKey)).join(" and ")}.`);
    } else {
      lines.push(
        `Right now: ${entry.drivers.map((d) => `${ctx.questionLabel(d.itemKey)} — ${d.answer ?? "not answered yet"}`).join("; ")}.`,
      );
    }
  }
  return lines;
}

function PathPanel({
  units,
  runs,
  labels,
  entries,
  scales,
  state,
  onJump,
}: {
  units: PresentableUnit[];
  runs: { sectionKey: string; title: string; indices: number[] }[];
  labels: string[];
  entries: PathEntry[];
  scales: Map<string, ResponseScale>;
  state: StateMessage | null;
  onJump: (itemKey: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "hidden">("all");
  const listRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const idBase = useId();

  const describeCtx = useMemo<DescribeContext>(() => {
    const byKey = new Map(units.map((u) => [unitKeyOf(u), u] as const));
    return {
      questionLabel: (key) => {
        const unit = byKey.get(key);
        return `“${unit ? shorten(unit.item.stem.text, 70) : key}”`;
      },
      optionLabel: (key, code) => {
        const item = byKey.get(key)?.item;
        if (!item || !("scale" in item)) return null;
        return scales.get(item.scale)?.options.find((o) => o.code === code)?.label ?? null;
      },
      isMulti: (key) => byKey.get(key)?.item.responseType === "multi_choice",
    };
  }, [units, scales]);

  const counts = useMemo(() => {
    const c = { answered: 0, hidden: 0, notReached: 0 };
    for (const e of entries) {
      if (e.answer !== null) c.answered += 1;
      if (e.state === "hidden") c.hidden += 1;
      if (e.state === "not_reached") c.notReached += 1;
    }
    return c;
  }, [entries]);

  // Keep the screen on show in view in the list, without moving focus or the page.
  const currentIndex = state?.phase === "running" ? state.index : null;
  useEffect(() => {
    const box = listRef.current;
    if (!box || currentIndex === null) return;
    const row = box.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`);
    if (!row) return;
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    // 40px clears the sticky section heading at the top of the list.
    if (top < box.scrollTop + 40 || top + row.offsetHeight > box.scrollTop + box.clientHeight - 8) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
  }, [currentIndex]);

  const where =
    state === null
      ? "Starting the preview…"
      : state.phase === "start"
        ? "On the start screen."
        : state.phase === "finished"
          ? "On the completion screen."
          : state.phase === "review"
            ? "On the review screen."
            : state.phase === "checkin"
              ? "On the check-in shown after several skipped questions."
              : state.phase === "pace"
                ? "On the “No rush” screen shown after very quick answers."
                : state.phase === "error"
                  ? "Stopped: the draft couldn't be run."
                  : null;

  const visibleRuns = runs
    .map((run) => ({ ...run, indices: run.indices.filter((i) => filter === "all" || entries[i]?.state === "hidden") }))
    .filter((run) => run.indices.length > 0);

  return (
    <aside className="st-pv-path" aria-labelledby={headingId}>
      <div className="st-pv-path-head">
        <h2 id={headingId}>Path</h2>
        <p className="st-pv-path-sum">
          {counts.answered} answered · {counts.hidden} hidden · {counts.notReached} not reached
        </p>
        {where ? <p className="st-pv-where">{where}</p> : null}
        <Segmented
          label="Show in the path"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Every screen" },
            { value: "hidden", label: `Hidden (${counts.hidden})` },
          ]}
        />
        <p className="st-pv-path-hint">Choose a screen to jump there. Answers given so far are kept.</p>
      </div>
      <div className="st-pv-path-list" ref={listRef}>
        {visibleRuns.length === 0 ? (
          <p className="st-pv-path-none">Nothing is hidden by the answers given so far.</p>
        ) : null}
        {visibleRuns.map((run) => (
          <section key={`${run.sectionKey}-${run.indices[0]}`} className="st-pv-section" aria-label={run.title}>
            <h3>{run.title}</h3>
            <ol>
              {run.indices.map((i, n) => {
                const entry = entries[i]!;
                const unit = units[i]!;
                const whyId = `${idBase}-why-${i}`;
                const why = entry.state === "hidden" ? whyHidden(unit, entry, describeCtx) : [];
                // A section's condition applies to every question in it. Said
                // once, then "the same as above", so twenty hidden rows are not
                // twenty copies of one sentence. The full text stays for screen
                // readers, which read each row on its own.
                const prev = n > 0 ? run.indices[n - 1] : undefined;
                const repeat =
                  why.length > 0 &&
                  prev !== undefined &&
                  entries[prev]?.state === "hidden" &&
                  whyHidden(units[prev]!, entries[prev]!, describeCtx).join(" ") === why.join(" ");
                const icon = STATE_ICON[entry.state];
                return (
                  <li key={i} data-index={i} className={`st-pv-row st-pv-row-${entry.state}`}>
                    <button
                      type="button"
                      className="st-pv-row-btn"
                      aria-current={entry.state === "current" ? "step" : undefined}
                      aria-describedby={why.length > 0 ? whyId : undefined}
                      onClick={() => onJump(entry.itemKey)}
                    >
                      <span className="st-pv-mark" aria-hidden="true">
                        {icon ? <Icon name={icon} size={14} /> : null}
                      </span>
                      <span className="st-pv-row-main">
                        <span className="st-pv-row-q">{labels[i]}</span>
                        <span className="st-pv-row-state">{stateText(entry)}</span>
                      </span>
                    </button>
                    {why.length > 0 ? (
                      <div id={whyId} className={`st-pv-why${repeat ? " st-pv-why-repeat" : ""}`}>
                        {repeat ? (
                          <>
                            <p aria-hidden="true">Hidden by the same condition as the row above.</p>
                            <span className="st-sr">{why.join(" ")}</span>
                          </>
                        ) : (
                          why.map((line) => <p key={line}>{line}</p>)
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </aside>
  );
}
