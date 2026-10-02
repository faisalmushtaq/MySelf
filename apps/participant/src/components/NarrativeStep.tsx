import { useEffect, useRef, useState } from "react";

/**
 * MyStory, inside MyThoughts.
 *
 * The survey reaches a narrative component and hands over. `flatten` has
 * placed it as one position in the walk — with a marker item, so conditions,
 * ordering, back navigation and timing need no special case — and the comment
 * it left said "the survey screen checks `narrative` and hands over to the
 * module". Nothing did. This is the hand-over.
 *
 * IT EMBEDS THE MODULE RATHER THAN REIMPLEMENTING IT. The chat is a real
 * thing that took a long time to get right: the typing delays, the voice
 * notes and their waveforms, the three retellings arriving one at a time, the
 * press-and-hold that chooses one, surviving a refresh. Rebuilding that in
 * React beside the original would produce two of them, and within a month
 * they would differ in ways nobody chose — and the one a child sees would be
 * whichever the survey happened to render.
 *
 * WHAT CROSSES THE BOUNDARY IS THE SITTING'S SESSION ID. That single value is
 * the join: the module stores its run against it, the sitting is stored
 * against it, and the export puts the conversation and the questionnaire side
 * by side because they agree about who this was. The module keeps its own
 * records and posts them itself, so a survey that cannot reach the network
 * still has a complete log of everything else.
 *
 * AND THE SURVEY KEEPS ITS OWN ACCOUNT. Reaching the module, finishing it, and
 * leaving it unfinished are all events in the sitting's log. The narrative
 * document may never arrive — no connectivity, a refused relay — and the
 * survey still has to be able to say what happened at this position.
 */

export interface NarrativeStepProps {
  /** Where the module is served from, without a trailing slash. */
  moduleUrl: string;
  protocol: string;
  protocolVersion: string;
  sessionId: string;
  releaseHash: string;
  /** Shown to the participant by the module, when the study collects one. */
  firstName?: string | undefined;
  onEvent: (type: string, payload?: Record<string, unknown>) => void;
  onDone: () => void;
}

/**
 * How long to wait before offering a way past it.
 *
 * A module that cannot load leaves a child looking at an empty rectangle, and
 * the one thing worse than skipping this section is a sitting that cannot be
 * finished. Long enough that a slow school connection is not mistaken for a
 * failure; short enough that nobody is stuck.
 */
const PATIENCE_MS = 20_000;

export function NarrativeStep(props: NarrativeStepProps) {
  const { moduleUrl, protocol, protocolVersion, sessionId, releaseHash, firstName, onEvent, onDone } = props;
  const [loaded, setLoaded] = useState(false);
  const [patient, setPatient] = useState(true);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  const source = (() => {
    const url = new URL(`${moduleUrl.replace(/\/$/, "")}/`);
    url.searchParams.set("embed", "1");
    url.searchParams.set("view", "participant");
    url.searchParams.set("start", "1");
    url.searchParams.set("protocol", protocol);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("releaseHash", releaseHash);
    // Silence means nobody, and the module is written to read correctly with
    // no name. Only sent when the study actually collected one.
    if (firstName) url.searchParams.set("name", firstName);
    return url.toString();
  })();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    onEvent("narrative_opened", { protocol, protocolVersion, sessionId });
  }, [onEvent, protocol, protocolVersion, sessionId]);

  useEffect(() => {
    const timer = setTimeout(() => setPatient(false), PATIENCE_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      /**
       * Only the module's own origin, and only the message it sends.
       *
       * A page in an iframe is not the only thing that can post here — an
       * extension, another frame, the page itself — and a stray message that
       * advanced the survey would skip a section without anybody doing
       * anything.
       */
      if (event.origin !== new URL(source).origin) return;
      const data = event.data as { type?: string; reason?: string; sessionId?: string } | null;
      if (data?.type !== "mystory:finished") return;
      if (data.sessionId && data.sessionId !== sessionId) return;
      setFinished(true);
      onEvent("narrative_finished", { protocol, protocolVersion, reason: data.reason ?? "finished" });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEvent, protocol, protocolVersion, sessionId, source]);

  return (
    <div className="narrative-step">
      <div className="narrative-frame">
        <iframe
          title="A short conversation"
          src={source}
          onLoad={() => setLoaded(true)}
          // The module records the participant's voice where the study allows
          // it, and an iframe is refused the microphone unless it is granted
          // one explicitly.
          allow="microphone"
        />
        {!loaded && <p className="narrative-waiting">Getting the conversation ready…</p>}
      </div>

      {finished ? (
        <div className="narrative-after">
          <p>That part is done. There is a little more of the survey to go.</p>
          <button type="button" className="primary" onClick={onDone}>
            Keep going
          </button>
        </div>
      ) : (
        !patient && (
          <div className="narrative-after">
            <p className="note">
              If the conversation will not load, you can carry on with the rest of the survey — nothing you have
              already answered is affected.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onEvent("narrative_abandoned", { protocol, protocolVersion, loaded });
                onDone();
              }}
            >
              Skip this part
            </button>
          </div>
        )
      )}
    </div>
  );
}
