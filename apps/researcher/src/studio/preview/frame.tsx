import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
// The participant's stylesheet, imported here and nowhere else in the
// researcher app: this document is the only place it applies, so the
// participant's global rules (html, body, buttons) never reach the Studio.
import "@participant/styles.css";
import "./frame.css";
import {
  applyAccessibilityPreferences,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  type AccessibilityPreferences,
} from "@participant/lib/accessibility.js";
import { describeFailure, prepareRelease, PreviewRunner, type PreparedRelease } from "./runner.js";
import {
  fromExpected,
  MSG_READY,
  MSG_STATE,
  parseGoto,
  parseLoad,
  type ReadyMessage,
  type StartAt,
  type StateMessage,
} from "./protocol.js";

/**
 * preview.html — the Studio's preview frame (docs/16 §5.6).
 *
 * Runs whatever release its parent sends, and reports where the run is. No
 * answer outlives the load it was given in, and nothing is written anywhere:
 * no IndexedDB, no service worker, no network (preview.html's policy refuses
 * the last two outright). See runner.tsx for what is and is not the
 * participant app.
 */

/**
 * Leave the keyboard where the researcher is.
 *
 * SurveyScreen moves focus to each new question's heading, which is right for
 * a participant: the survey is their whole screen. Here it is one pane of the
 * Studio, and a restart, a jump from the path panel or an edit typed in the
 * editor would each pull focus into this frame — mid-keystroke, in the last
 * case. So programmatic focus is ignored while this document does not have
 * focus, and works as it does on a device once the researcher is working in
 * the frame. The patch is this frame's own prototype; the Studio's is untouched.
 */
const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
  if (document.hasFocus()) nativeFocus.call(this, options);
};

type Loaded =
  | { nonce: string; startAt: StartAt; release: PreparedRelease }
  | { nonce: string; error: string };

/** Only ever to our own parent, and only if it is on this origin. */
function post(message: ReadyMessage | StateMessage) {
  window.parent.postMessage(message, window.location.origin);
}

function FrameApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [jump, setJump] = useState<{ target: string; seq: number } | null>(null);
  // Held above the runner so a restart keeps the researcher's reading
  // settings, as the participant app keeps them between sittings. Never stored.
  const [accessibility, setAccessibility] = useState<AccessibilityPreferences>(DEFAULT_ACCESSIBILITY_PREFERENCES);
  const nonce = useRef<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!fromExpected(event, { origin: window.location.origin, source: window.parent })) return;
      const load = parseLoad(event.data);
      if (load) {
        nonce.current = load.nonce;
        setJump(null);
        try {
          setLoaded({ nonce: load.nonce, startAt: load.startAt, release: prepareRelease(load.manifest) });
        } catch (error) {
          const message = describeFailure(error);
          setLoaded({ nonce: load.nonce, error: message });
          post({
            type: MSG_STATE,
            nonce: load.nonce,
            phase: "error",
            index: null,
            itemKey: null,
            answers: {},
            visibility: {},
            error: message,
          });
        }
        return;
      }
      const go = parseGoto(event.data);
      // A jump meant for an earlier load would land on the wrong survey.
      if (go && go.nonce === nonce.current) setJump((j) => ({ target: go.target, seq: (j?.seq ?? 0) + 1 }));
    };
    window.addEventListener("message", onMessage);
    post({ type: MSG_READY });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!loaded) {
    const framed = window.parent !== window;
    return (
      <div className="app">
        <div className="screen start">
          <p className="hint pv-waiting" role="status">
            {framed
              ? "Getting the preview ready…"
              : "This page is MySelf Studio's preview frame. Open a survey in the Studio and choose Preview to use it."}
          </p>
        </div>
      </div>
    );
  }

  if ("error" in loaded) {
    return (
      <div className="app">
        <div className="screen checkin" role="alert">
          <h1>This draft can&apos;t be shown yet</h1>
          <p>The participant app would not be able to run it either. The Studio lists what needs fixing.</p>
          <pre className="pv-error">{loaded.error}</pre>
        </div>
      </div>
    );
  }

  const loadNonce = loaded.nonce;
  return (
    <PreviewRunner
      key={loadNonce}
      release={loaded.release}
      startAt={loaded.startAt}
      jump={jump}
      accessibility={accessibility}
      onAccessibility={(next) => {
        setAccessibility(next);
        applyAccessibilityPreferences(next);
      }}
      onState={(state) => post({ type: MSG_STATE, nonce: loadNonce, ...state })}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrameApp />
  </React.StrictMode>,
);
