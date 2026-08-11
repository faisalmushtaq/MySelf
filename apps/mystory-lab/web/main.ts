import { Gateway, RelayAdapter, type ModelCall } from "@myself/llm";
import { NarrativeRunner, checkProtocol, protocols, type Screen } from "@myself/narrative";
import { session } from "./session.js";

/**
 * The lab, in the browser.
 *
 * Two ways to reach a model, and no third:
 *
 *   - Served by `server.mjs` with a key configured, it posts to that server,
 *     which holds the key and makes the real call. A provider key never
 *     reaches a page.
 *   - Served as static files, it calls the relay, which holds the key. That
 *     needs somebody signed in with a role, because the relay will not spend
 *     the study's money for a caller it cannot name.
 *
 * THERE IS NO MOCK MODE. There was, and it was the wrong idea: a mock reply
 * sits in the same bubble as a real one and reads as a broken model rather
 * than as a stand-in, so somebody testing the module cannot tell which they
 * are looking at. When there is no model to talk to, this says so and starts
 * nothing. The MockAdapter still exists for the tests, where determinism is
 * the point and nobody is being asked to judge the writing.
 */

const $ = (id: string) => document.getElementById(id)!;

let live = false;
/** The deployed relay this build was given, if any. */
let relay: string | null = null;
/**
 * A tester link key from the URL, if this page was opened from one.
 *
 * Read once at load and never written back, so it stays in the address bar
 * where the person who was sent it can see it, and does not end up in a form
 * field somebody could edit into somebody else's.
 */
const linkKey = new URL(window.location.href).searchParams.get("k");
let sessionId: string | null = null;
let localRunner: NarrativeRunner | null = null;
let localCalls: ModelCall[] = [];

const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as T;
}

// ── Set-up ────────────────────────────────────────────────────────────────

/**
 * Is there a server behind this page?
 *
 * Asked rather than configured, because the same built files are served both
 * ways: by `server.mjs` during prompt-writing, and as static files on Pages
 * for anyone who wants to see what the module does.
 */
declare const __RELAY_URL__: string;
declare const __BUILD_STAMP__: string;

/**
 * How this page reaches a model, in order of preference.
 *
 *   The local server, when one is running with a key. What a researcher uses
 *   while writing prompts.
 *   The deployed relay, when this build was given one. The Cloud Function
 *   holds the key; the page holds nothing.
 *   Neither, in which case there is nothing to run and the page says so.
 */
async function detectServer(): Promise<void> {
  try {
    const info = await api<{ live: boolean }>("/api/protocols");
    live = info.live;
    // A local server that has no key is not a way to reach a model. It used to
    // be enough to leave the relay unset, because the mock caught everything
    // that fell through; without the mock that combination is a dead page, and
    // it is the exact combination a researcher has before they add their key.
    relay = live ? null : __RELAY_URL__ || null;
  } catch {
    // No local server. A build pointed at the relay can still make live calls,
    // once somebody is signed in to authorise them.
    relay = __RELAY_URL__ || null;
    live = false;
  }
  $("mode").textContent = live
    ? "A key is configured on the server, which holds it and makes the calls."
    : relay
      ? linkKey
        ? "Running on a tester link, which the relay accepts in place of an account."
        : "Calls go through the study's relay, which holds the key — this page never does. Sign in to use it."
      : "This build has no model to talk to: no local server with a key, and no relay configured.";
  if (!live && !relay) {
    ($("start") as HTMLButtonElement).disabled = true;
    // Said where a participant can read it, not only in the lab's mode line.
    // Somebody handed a link to a build with nothing behind it should be told
    // that, rather than left looking at a page that does nothing when tapped.
    $("bootNote").innerHTML =
      `<div class="alert">This page cannot reach the model at the moment, so there is nothing to start.
       Do let whoever sent you this link know.</div>`;
  }
}

for (const p of protocols) {
  const option = document.createElement("option");
  option.value = p.key;
  option.textContent = `${p.name} (${p.key}@${p.version})`;
  $("protocol").append(option);
}
const showGate = () => {
  const protocol = protocols.find((p) => p.key === ($("protocol") as HTMLSelectElement).value)!;
  const problems = checkProtocol(protocol);
  $("gate").textContent = problems.length
    ? `Publish gate: ${problems.join(" · ")}`
    : `Publish gate: clean. Identifiers permitted in prompts: ${
        protocol.permittedIdentifiers.length ? protocol.permittedIdentifiers.join(", ") : "none"
      }.`;
};
$("protocol").addEventListener("change", showGate);
showGate();

/**
 * The topic, as the young person will hear it.
 *
 * `{topic}` goes into two kinds of sentence: one spoken TO the participant
 * ("I will ask you a few questions about {topic}") and several written ABOUT
 * them for the model ("A young person was asked to describe {topic}"). A topic
 * has to survive both, and nothing on this form used to say so.
 *
 * The trap is quiet. "how they feel about the future" reads perfectly in the
 * prompts and produces "I will ask you a few questions about how they feel
 * about the future" on the participant's screen, which is addressed to nobody.
 * The default reads correctly in both only because it is impersonal.
 *
 * So the sentence is shown rather than described. A researcher writing a topic
 * sees the line a child will read, as they type it — which is the check, and
 * the pronoun warning below is only there to catch the eye.
 */
const THIRD_PERSON = /\b(they|them|their|theirs|he|him|his|she|her|hers|the (?:young person|child|participant|pupil|student))\b/i;

const showTopic = () => {
  const topic = ($("topic") as HTMLInputElement).value.trim();
  const protocol = protocols.find((p) => p.key === ($("protocol") as HTMLSelectElement).value)!;
  // The stage that speaks to the participant using the topic, whichever it is
  // in this protocol — found rather than assumed, so a protocol that words its
  // opening differently is previewed correctly.
  const spoken = protocol.stages.find((s) => !s.modelConfigKey && s.text?.includes("{topic}"));

  // Whether this protocol has a topic at all is a property of the protocol,
  // not of the run. `np.phone_wellbeing` asks about one subject and its
  // questions are written for it; there is nothing here for anybody to set.
  const usesTopic = protocol.permittedVariables.includes("topic");
  ($("topicField") as HTMLDivElement).hidden = !usesTopic;

  if (!spoken || topic === "") {
    $("topicPreview").innerHTML = "";
    return;
  }

  const sentence = spoken.text!.replace(/\{topic\}/g, topic);
  const pronoun = THIRD_PERSON.exec(topic);
  $("topicPreview").innerHTML =
    `<p class="note preview-line">They will read: &ldquo;${escapeHtml(sentence)}&rdquo;</p>` +
    (pronoun
      ? `<p class="note warn-text">That says &ldquo;${escapeHtml(pronoun[0])}&rdquo; to the person it is about. A topic is
         also written about the participant in the model prompts, so it needs to read correctly both ways &mdash;
         &ldquo;how school has been this term&rdquo; rather than &ldquo;how they feel about school&rdquo;.</p>`
      : "");
};
$("topic").addEventListener("input", showTopic);
$("protocol").addEventListener("change", showTopic);
showTopic();

// ── Rendering ─────────────────────────────────────────────────────────────

interface Frame {
  screen: Screen;
  records: { seq: number; source: string; kind: string; text: string | null; data: unknown }[];
  calls: ModelCall[];
}

/**
 * The conversation, as a thread.
 *
 * It accumulates rather than being replaced. A young person is being asked to
 * recognise a retelling of what they said as theirs, and a screen that has
 * thrown away everything they said is a poor place to ask that. Each turn
 * appends: what the bot asked, what they answered, in order, scrolling.
 *
 * The stage controls live under the thread rather than inside it, because
 * choosing between three write-ups, dragging a slider and editing a paragraph
 * are not messages — they are things done to what the messages produced.
 */
type Who = "them" | "me" | "system";

const bubble = (who: Who, html: string): string =>
  who === "system"
    ? `<div class="msg from-them"><div class="bubble system">${html}</div></div>`
    : `<div class="msg from-${who}">
         <div class="avatar">${who === "them" ? "\u{1F916}" : "\u{1F9D2}"}</div>
         <div class="bubble">${html}</div>
       </div>`;

/**
 * Everything said so far, rebuilt from the records.
 *
 * The records are the source, not a parallel list the UI keeps: what appears
 * in the thread is exactly what was stored, which is the point of a lab whose
 * job is to show what would be stored.
 *
 * Not everything stored is a message, though. The three retellings are each
 * recorded as shown, because they were — but they are shown as cards to
 * choose between, and repeating them as chat bubbles above the cards says the
 * same thing twice.
 */
function threadFrom(records: Frame["records"]): string {
  const parts: string[] = [];
  for (const r of records) {
    const data = (r.data ?? {}) as Record<string, unknown>;

    if (r.kind === "request_shown" || r.kind === "clarification_request") {
      if (r.text) parts.push(bubble("them", escapeHtml(r.text)));
    } else if (r.kind === "model_shown") {
      // A candidate retelling: it belongs in the cards, not in the thread.
      if (typeof data["index"] === "number") continue;
      if (r.text) parts.push(bubble("them", escapeHtml(r.text)));
    } else if (r.kind === "participant_original" || r.kind === "participant_clarification") {
      if (r.text) parts.push(bubble("me", escapeHtml(r.text)));
    } else if (r.kind === "participant_correction") {
      if (r.text) parts.push(bubble("me", escapeHtml(r.text)));
    } else if (r.kind === "participant_reaction" && typeof data["persona"] === "string") {
      // Which one they picked, said as a person would say it. The retelling
      // itself is on screen; repeating it here is noise.
      parts.push(bubble("me", `I&rsquo;ll take the <em>${escapeHtml(data["persona"])}</em> one.`));
    } else if (r.kind === "participant_rating") {
      parts.push(bubble("me", `${escapeHtml(data["rating"])} out of ${escapeHtml(data["max"])}`));
    } else if (r.kind === "participant_edit") {
      parts.push(bubble("system", "They rewrote the write-up in their own words."));
    } else if (r.kind === "participant_reaction" && typeof data["restored"] === "string") {
      parts.push(bubble("system", "They put the previous version back."));
    } else if (r.kind === "fallback_applied" && typeof data["reason"] === "string" && !data["persona"]) {
      parts.push(bubble("system", `The model could not be reached: ${escapeHtml(data["reason"])}.`));
    }
  }
  return parts.join("");
}

function scrollThread(): void {
  const thread = $("thread");
  thread.scrollTop = thread.scrollHeight;
}

/** Wire whatever controls this stage put on screen. */
function wireStageControls(): void {
  const submit = () => {
    const picked = document.querySelector<HTMLInputElement>('input[name="choice"]:checked');
    const range = document.getElementById("ratingRange") as HTMLInputElement | null;
    const typed = document.getElementById("input") as HTMLTextAreaElement | null;
    // `echo` only when the value is something they wrote. A choice sends an
    // index and a rating sends a number, and neither is a sentence anybody
    // said — the thread renders those as "I'll take the plain one" and
    // "7 out of 10" once recorded, which is what should appear.
    const wrote = picked === null && range === null && typed !== null;
    void turn({ action: "submit", input: picked?.value ?? range?.value ?? typed?.value ?? "", echo: wrote });
  };

  document.getElementById("send")?.addEventListener("click", submit);
  document.getElementById("cont")?.addEventListener("click", () => void turn({ action: "next" }));
  document.getElementById("skip")?.addEventListener("click", () => void turn({ action: "skip" }));
  document.getElementById("revert")?.addEventListener("click", () => void turn({ action: "revert" }));
  document.getElementById("keep")?.addEventListener("click", () => {
    const edited = (document.getElementById("scenarioEdit") as HTMLTextAreaElement | null)?.value ?? "";
    void turn({ action: "keep", input: edited });
  });

  // Enter sends; Shift+Enter is a new line. What a message box does.
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  });
  input?.focus();

  // Cmd/Ctrl+Enter keeps an edited write-up, as the original does.
  const edit = document.getElementById("scenarioEdit") as HTMLTextAreaElement | null;
  edit?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void turn({ action: "keep", input: edit.value });
    }
  });

  document.querySelectorAll<HTMLInputElement>('input[name="choice"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".card-choice").forEach((c) => c.classList.remove("picked"));
      radio.closest(".card-choice")?.classList.add("picked");
    });
  });

  const range = document.getElementById("ratingRange") as HTMLInputElement | null;
  range?.addEventListener("input", () => {
    const out = document.getElementById("ratingValue");
    if (out) out.textContent = range.value;
  });
}

function render(frame: Frame): void {
  const s = frame.screen;
  currentKind = s.kind;

  $("thread").innerHTML = threadFrom(frame.records) || `<p class="note">Start a run to see the conversation.</p>`;
  scrollThread();

  // How far along. Announced politely rather than assertively: a screen reader
  // being interrupted to say "step 4 of 6" in the middle of reading the
  // question is worse than not being told.
  $("progress").innerHTML = s.progress
    ? `<div class="progress">
         <div class="progress-track" role="progressbar" aria-valuenow="${s.progress.step}"
              aria-valuemin="1" aria-valuemax="${s.progress.of}"
              aria-label="How far through this part you are">
           <div class="progress-fill" style="width: ${Math.round((s.progress.step / s.progress.of) * 100)}%"></div>
         </div>
         <p class="progress-label" aria-live="polite">${
           s.finished ? "Finished" : `Step ${s.progress.step} of ${s.progress.of}`
         }</p>
       </div>`
    : "";

  /* ── The stage area: what this screen asks the participant to DO ──────── */

  const choices = (s.choices ?? [])
    .map(
      // The persona name is a researcher's key for a prompt — `their_words`,
      // `feeling` — and is shown only in the lab. A participant choosing
      // between three retellings should be choosing on what they say; a card
      // labelled "their words" is advertising itself as the honest one, and
      // the choice is data we would then have spoiled.
      (c, i) => `<label class="card-choice${i === 0 ? " picked" : ""}">
          <input type="radio" name="choice" value="${c.index}"${i === 0 ? " checked" : ""} />
          <span class="who lab-only">${escapeHtml(c.persona)}</span>
          ${escapeHtml(c.text)}
        </label>`,
    )
    .join("");

  // A slider with named ends, as the original has it: "needs a lot of work"
  // to "this looks good". Eleven radio buttons is a developer's idea of a
  // rating scale, and it reads as a form rather than an opinion.
  const rating = s.rating
    ? `<div class="slider-wrap">
         <div class="slider-ends"><span class="low">needs a lot of work</span><span class="high">this looks good</span></div>
         <input type="range" id="ratingRange" min="0" max="${s.rating.max}" value="${s.rating.max}" step="1" />
         <p class="slider-value"><span id="ratingValue">${s.rating.max}</span> out of ${s.rating.max}</p>
       </div>`
    : "";

  // The adapt stage, split the way the original splits it: rewrite it
  // yourself, or ask the model to. Two different acts producing two different
  // kinds of data, so two visibly different panels.
  const adapt = s.editable
    ? `<div class="adapt-block">
         <h3>Change it yourself</h3>
         <textarea id="scenarioEdit" class="scenario-edit" rows="7">${escapeHtml(s.scenario ?? "")}</textarea>
         <p class="hint-right">Press \u2318/Ctrl + Enter to keep it</p>
         <div class="row">
           <button class="secondary" id="revert">Reset to the last version</button>
           <button class="primary" id="keep">I&rsquo;m happy with this</button>
         </div>
       </div>
       <div class="adapt-ai">
         <h3>Or ask for a rewrite</h3>
         ${
           s.needsRequest
             ? `<p class="note warn-text">Tell me what to change and I will rewrite it \u2014 or edit it yourself above.</p>`
             : ""
         }
         ${
           s.unchanged
             ? `<p class="note warn-text">I could not make that change from your own words, so I left it as it was.</p>`
             : ""
         }
         <div class="composer">
           <textarea id="input" rows="1" placeholder="Describe what you&rsquo;d like to change\u2026"></textarea>
           <button class="primary send-round" id="send" title="Ask for a rewrite">\u2191</button>
         </div>
       </div>`
    : "";

  // The retelling under discussion, quoted, at the stage where it is rated.
  const quoted = s.scenario && !s.editable ? `<blockquote class="scenario">${escapeHtml(s.scenario)}</blockquote>` : "";

  const composer =
    s.expectsInput && !choices && !rating && !s.editable
      ? `<div class="composer">
           <textarea id="input" rows="1" placeholder="Type your answer\u2026"></textarea>
           <button class="primary send-round" id="send" title="Send">\u2191</button>
         </div>`
      : "";

  const advance = s.finished
    ? `<p class="note">Finished.${s.stopped ? ` Stopped: ${escapeHtml(s.stopped.reason)}` : ""}</p>`
    : s.editable
      ? ""
      : `<div class="row">
           ${
             s.expectsInput && !composer
               ? '<button class="primary" id="send">Continue</button>'
               : composer
                 ? ""
                 : '<button class="primary" id="cont">Continue</button>'
           }
           ${s.optional ? '<button class="secondary" id="skip">Leave it as it is</button>' : ""}
         </div>`;

  $("stageArea").innerHTML = `${quoted}${choices ? `<div class="cards">${choices}</div>` : ""}${rating}${adapt}${composer}${advance}`;

  $("fallbackNote").innerHTML = s.fallback
    ? `<div class="alert"><strong>Fallback applied:</strong> ${escapeHtml(s.fallback.reason)} \u2192
       <code>${escapeHtml(s.fallback.applied)}</code>. Nothing the participant said was lost.</div>`
    : "";
  $("controls").innerHTML = "";

  wireStageControls();

  $("records").querySelector("tbody")!.innerHTML = frame.records
    .map(
      (r) => `<tr><td>${r.seq}</td><td class="src-${r.source}">${r.source}</td>
        <td><code>${r.kind}</code></td>
        <td class="wrapcell">${escapeHtml(r.text ?? (r.data ? JSON.stringify(r.data) : ""))}</td></tr>`,
    )
    .join("");

  if (frame.calls.length > 0) {
    $("calls").querySelector("tbody")!.innerHTML = frame.calls
      .map(
        (c) => `<tr><td>${c.stage}</td><td>${escapeHtml(c.modelServed ?? c.modelRequested)}</td>
          <td>${c.status}${c.errorKind ? ` <span class="badge warn">${c.errorKind}</span>` : ""}</td>
          <td>${c.latencyMs ?? "—"}</td>
          <td>${c.usage ? `${c.usage.inputTokens ?? "?"}/${c.usage.outputTokens ?? "?"}` : "—"}</td>
          <td>${c.containedIdentifiers ? '<span class="badge warn">yes</span>' : "no"}</td></tr>`,
      )
      .join("");
  }
}

// ── Driving a run ─────────────────────────────────────────────────────────

/**
 * What is happening while nothing is happening.
 *
 * A live model call is seconds, not milliseconds, and the stage after the
 * interview makes several: extract, then one retelling per persona. Without
 * this the page sits there after a click, which reads as broken — the first
 * live run of this looked "slow and glitchy" for exactly that reason, and the
 * retellings appeared to never arrive when in fact nobody had waited.
 *
 * The wording is per stage, because "working…" does not tell anyone whether to
 * keep waiting. A participant is told how many pieces of writing are coming.
 */
const WAITING: Record<string, string> = {
  // Leaving the introduction starts the interview, which is a model call.
  introduction: "Getting ready",
  collect: "Thinking about what you said. If that was the last question, the write-ups take a few seconds.",
  extract: "Reading back over the conversation",
  generate: "Writing the three short versions",
  adapt: "Rewriting it the way you asked",
  follow_up: "Thinking about what you said",
  interpret: "Reading back over what you wrote",
};

let busy = false;
/** The kind of stage on screen, so the waiting note can say what is coming. */
let currentKind = "introduction";

function setBusy(stageKind: string | null): void {
  busy = stageKind !== null;
  document.querySelectorAll<HTMLButtonElement>("#stageArea button").forEach((b) => (b.disabled = busy));
  document.querySelectorAll<HTMLTextAreaElement>("#stageArea textarea").forEach((t) => (t.disabled = busy));

  const existing = document.getElementById("thinking");
  // Choosing, rating and the closing screen call nothing, so a bot pretending
  // to think there would be theatre.
  if (stageKind === null || !(stageKind in WAITING)) {
    existing?.remove();
    return;
  }
  if (existing) return;

  // The dots go in the thread, on the bot's side, where its reply will
  // appear — not on a spinner elsewhere on the page. That is what makes a
  // wait read as someone composing an answer rather than as a stall.
  const node = document.createElement("div");
  node.id = "thinking";
  node.className = "msg from-them";
  node.innerHTML = `<div class="avatar">\u{1F916}</div>
    <div class="bubble">
      <span class="dots"><span></span><span></span><span></span></span>
      <p class="thinking-label">${escapeHtml(WAITING[stageKind])}</p>
    </div>`;
  $("thread").append(node);
  scrollThread();
}

async function turn(payload: { action: string; input?: string; echo?: boolean }): Promise<void> {
  // Ignore a second click while a call is in flight: double-submitting a turn
  // is how a participant ends up paying for two interviews of themselves.
  if (busy) return;

  /**
   * Their message, on screen the instant they send it.
   *
   * The thread is rebuilt from the records, and the records only come back
   * when the model does — so until now, sending an answer made it disappear
   * for the several seconds the call takes, and the dots appeared where the
   * reply would go. You could watch your own sentence vanish.
   *
   * No messaging app has ever worked that way. The bubble goes up
   * immediately and is replaced by the recorded one when the turn returns,
   * which is the same text: this is the appearance arriving early, not a
   * second copy or an optimistic guess about what will be stored.
   */
  const said = payload.echo === true ? payload.input?.trim() : undefined;
  if (said) {
    $("thread").insertAdjacentHTML("beforeend", bubble("me", escapeHtml(said)));
    scrollThread();
  }

  setBusy(currentKind);
  try {
    if (localRunner) {
      const screen =
        payload.action === "next"
          ? await localRunner.next()
          : payload.action === "skip"
            ? await localRunner.skip()
            : payload.action === "keep"
              ? await localRunner.keepScenario(payload.input ?? "")
              : payload.action === "revert"
                ? localRunner.revertScenario()
                : await localRunner.submit(payload.input ?? "");
      render({ screen, records: localRunner.all, calls: localCalls });
      return;
    }
    render(await api<Frame>("/api/turn", { sessionId, ...payload }));
  } catch (error) {
    // A failed turn must not leave the page disabled and silent.
    $("stageArea").innerHTML =
      `<div class="alert"><strong>Something went wrong:</strong>
       ${escapeHtml(String((error as Error).message ?? error))}.
       Nothing that was written has been lost — it is in the records below.</div>`;
  } finally {
    setBusy(null);
  }
}

$("start").addEventListener("click", () => {
  void (async () => {
    const key = ($("protocol") as HTMLSelectElement).value;
    const firstName = ($("firstName") as HTMLInputElement).value;
    const topic = ($("topic") as HTMLInputElement).value;
    const online = ($("online") as HTMLInputElement).checked;

    $("calls").querySelector("tbody")!.innerHTML = "";

    if (live) {
      // A local server with a key, which holds it and makes the call.
      localRunner = null;
      const data = await api<Frame & { sessionId: string; provider: string }>("/api/start", {
        protocol: key,
        firstName,
        topic,
        provider: "openai",
        online,
      });
      sessionId = data.sessionId;
      $("providerBadge").textContent = `provider: ${data.provider}`;
      render({ ...data, calls: [] });
      return;
    }

    /**
     * Otherwise the relay, or nothing at all.
     *
     * There is deliberately no fallback to a mock. A mock reply is
     * indistinguishable from a real one at a glance — "The participant
     * described (the participant is ready)" appeared on a phone and read as a
     * broken model rather than as a stand-in — and somebody testing the module
     * has no way to know which they are looking at. Refusing is honest; a
     * convincing imitation of the thing under test is not.
     */
    if (!relay) {
      $("bootNote").innerHTML =
        `<div class="alert">This page has no model to talk to: no local server with a key, and no relay
         configured in this build. Nothing has been started.</div>`;
      return;
    }

    /**
     * A tester link stands in for signing in.
     *
     * Somebody sent this link to try the module. Asking them to make a Google
     * account first loses most of them before the first screen, and the ones
     * it does not lose have stopped being a fair test of what a participant
     * would do. The key in the URL is the credential; the relay bounds what it
     * can cost and can switch it off.
     */
    const token = linkKey ? null : await session.token();
    if (!linkKey && !token) {
      $("bootNote").innerHTML =
        `<div class="alert">Sign in first — the relay will not spend the study's money for somebody it
         cannot name. If you were sent a link to test this, use that link: it needs no account.</div>`;
      return;
    }

    localCalls = [];
    const gateway = new Gateway({
      adapters: [new RelayAdapter({ url: relay, ...(linkKey ? { linkKey } : { token: token! }) })],
      onCall: (call) => {
        const at = localCalls.findIndex((c) => c.callId === call.callId);
        if (at >= 0) localCalls[at] = call;
        else localCalls.push(call);
      },
    });
    localRunner = new NarrativeRunner(
      protocols.find((p) => p.key === key)!,
      { sessionId: `lab_${Date.now().toString(36)}`, variables: { first_name: firstName, topic }, online },
      gateway,
    );
    $("providerBadge").textContent = "provider: relay (the key stays on the server)";
    render({ screen: localRunner.start(), records: localRunner.all, calls: localCalls });
  })();
});

/**
 * The page is up.
 *
 * Set once the protocol list, the gate and the mode line are all filled in,
 * so the plain script in the document can tell "still loading" from "failed"
 * — which look identical from the outside, and which have opposite answers to
 * "should I wait?".
 */
(window as unknown as { __mystoryReady?: boolean }).__mystoryReady = true;
($("start") as HTMLButtonElement).disabled = false;

/**
 * Sign-in, shown only where it does something.
 *
 * A local server with a key needs nobody signed in — it is the researcher's
 * own machine. The relay does: it spends money, and it will not do that for a
 * caller it cannot name.
 */
function wireSignIn(): void {
  const signIn = $("signIn") as HTMLButtonElement;
  const out = $("signOut") as HTMLButtonElement;
  if (!session.available || !relay) return;

  session.onChange((user) => {
    signIn.hidden = user !== null;
    out.hidden = user === null;
    $("who").textContent = user ? `signed in as ${user.email ?? user.uid}` : "not signed in";
  });
  signIn.addEventListener("click", () => {
    void session.signIn().catch((error: Error) => {
      $("bootNote").innerHTML = `<div class="alert">Could not sign in: ${escapeHtml(error.message)}</div>`;
    });
  });
  out.addEventListener("click", () => void session.signOut());
}

/**
 * The participant view.
 *
 * The same markup and the same runner with the instrumentation hidden, so
 * what is being looked at is what would actually run — a mock-up would drift
 * from the thing within a week.
 *
 * It is in the URL (`?view=participant`) so it can be sent to somebody: a
 * colleague, a teacher, an ethics committee. Someone opening that link should
 * see what a young person sees and nothing about how it is built.
 */
function wireViewToggle(): void {
  const toggle = $("viewToggle") as HTMLButtonElement;

  const apply = (participant: boolean) => {
    document.body.classList.toggle("participant-view", participant);
    toggle.textContent = participant ? "Back to the lab" : "See it as a participant";
    const url = new URL(window.location.href);
    if (participant) url.searchParams.set("view", "participant");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  };

  /**
   * Arriving on `?view=participant` is not the same as switching to it.
   *
   * A researcher who toggled needs the way back. Somebody handed the link is
   * a participant for the duration, and "Back to the lab" is both meaningless
   * to them and an invitation to somewhere they should not be — it was
   * floating over the conversation on a tester's phone, which is what
   * prompted this.
   *
   * So the toggle is removed entirely for a linked run, rather than hidden by
   * a class somebody could flip: there is nothing to find in the markup.
   */
  const linked = new URL(window.location.href).searchParams.get("view") === "participant";
  if (linked) {
    apply(true);
    toggle.remove();
    return;
  }

  apply(false);
  toggle.addEventListener("click", () => apply(!document.body.classList.contains("participant-view")));
}

/**
 * A run described in the URL, so a link can be sent to somebody.
 *
 *   ?protocol=np.phone_wellbeing&view=participant&start=1
 *
 * The point is a tester who is not a researcher. Asking them to pick the right
 * protocol from a dropdown before they see anything is asking them to get the
 * setup right on your behalf, and some of them will not, and you will read
 * their feedback about the wrong instrument.
 *
 * An unknown protocol key is left alone rather than silently falling back to
 * the first in the list, because a link that quietly runs a different study
 * than the one it names is worse than a link that does not work.
 */
function applyLinkedRun(): { start: boolean } {
  const params = new URL(window.location.href).searchParams;

  const wanted = params.get("protocol");
  if (wanted !== null) {
    const select = $("protocol") as HTMLSelectElement;
    if (protocols.some((p) => p.key === wanted)) select.value = wanted;
    else {
      $("bootNote").innerHTML =
        `<div class="alert">This link asks for a protocol called <code>${escapeHtml(wanted)}</code>,
         which is not one this build ships. Nothing has been started.</div>`;
      return { start: false };
    }
  }

  const name = params.get("name");
  if (name !== null) ($("firstName") as HTMLInputElement).value = name;
  const topic = params.get("topic");
  if (topic !== null) ($("topic") as HTMLInputElement).value = topic;

  showGate();
  showTopic();
  return { start: params.get("start") === "1" };
}

/**
 * Minting a tester link, from the page the researcher is already signed in to.
 *
 * A callable function is ordinary HTTPS underneath — `{data}` in, `{result}`
 * out — so this posts to it rather than pulling in the Functions SDK for one
 * call. The owner check is on the server, where it belongs; this button being
 * visible is a convenience, not a permission.
 */
async function callable<T>(name: string, data: unknown): Promise<T> {
  const token = await session.token();
  if (!token) throw new Error("sign in first");
  const base = (relay ?? "").replace(/\/llmRelay$/, "");
  const res = await fetch(`${base}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `that failed (${res.status})`);
  return body.result as T;
}

function wireTesterLink(): void {
  const button = $("makeLink") as HTMLButtonElement;
  if (!relay || !session.available) return;
  session.onChange((user) => {
    button.hidden = user === null;
  });

  button.addEventListener("click", () => {
    void (async () => {
      const label = window.prompt("What is this link for? (so you can recognise it when switching it off)");
      if (label === null || label.trim() === "") return;
      button.disabled = true;
      try {
        const made = await callable<{ key: string; expiresInDays: number; callCap: number }>("createTesterLink", {
          label,
        });
        const url = new URL(window.location.href);
        url.search = "";
        url.searchParams.set("protocol", ($("protocol") as HTMLSelectElement).value);
        url.searchParams.set("view", "participant");
        url.searchParams.set("start", "1");
        url.searchParams.set("k", made.key);
        $("linkOut").innerHTML =
          `<div class="alert"><strong>Send this. It needs no account.</strong>
           <p class="note" style="word-break: break-all; margin-top: .5rem;"><code>${escapeHtml(url.toString())}</code></p>
           <p class="note">Good for ${made.expiresInDays} days or ${made.callCap} model calls, whichever runs out
           first, and you can switch it off at any time. Shown once — nothing can recover the key after this.</p></div>`;
      } catch (error) {
        $("linkOut").innerHTML = `<div class="alert">Could not make a link: ${escapeHtml((error as Error).message)}</div>`;
      } finally {
        button.disabled = false;
      }
    })();
  });
}

$("buildStamp").textContent = `built ${__BUILD_STAMP__} UTC`;
wireViewToggle();
void detectServer().then(() => {
  wireSignIn();
  wireTesterLink();

  /**
   * Sign-in is lab furniture right up until it is the only thing between a
   * tester and the page working. When this build talks to the relay and
   * nobody is signed in, the button has to be reachable even in the
   * participant view — otherwise the link written for testers is the one
   * link on which they cannot begin.
   */
  if (relay && session.available && !linkKey) {
    session.onChange((user) => {
      $("signIn").classList.toggle("lab-only", user !== null);
    });
  }

  const { start } = applyLinkedRun();
  // Started only once there is something to start against: before this
  // resolves the page does not yet know whether it has a relay, a server or
  // the mock, and would pick the wrong one.
  if (start) ($("start") as HTMLButtonElement).click();
});
