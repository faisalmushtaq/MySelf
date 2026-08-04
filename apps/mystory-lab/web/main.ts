import { Gateway, MockAdapter, type ModelCall } from "@myself/llm";
import { NarrativeRunner, checkProtocol, protocols, type NarrativeProtocol, type Screen } from "@myself/narrative";

/**
 * The lab, in the browser.
 *
 * One page, two modes, decided by what is actually there:
 *
 *   - Served by `server.mjs` with a key configured, it posts to that server,
 *     which holds the key and makes the real call. A provider key never
 *     reaches a page.
 *   - Served as static files — GitHub Pages, or anywhere — there is no server,
 *     so it runs the same protocols in the browser against the deterministic
 *     mock. Every stage, every record, every fallback, no key and no cost.
 *
 * The second mode is what makes this shareable. Somebody can click through the
 * whole thing, see exactly what a young person would see and exactly what
 * would be stored, and nothing has been sent anywhere.
 */

const $ = (id: string) => document.getElementById(id)!;

let live = false;
let sessionId: string | null = null;
let localRunner: NarrativeRunner | null = null;
let localCalls: ModelCall[] = [];

const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Swap every model stage onto the mock, for running without a key. */
const onMock = (protocol: NarrativeProtocol): NarrativeProtocol => ({
  ...protocol,
  stages: protocol.stages.map((s) => (s.modelConfigKey ? { ...s, modelConfigKey: "mc.mock" } : s)),
});

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
async function detectServer(): Promise<void> {
  try {
    const info = await api<{ live: boolean }>("/api/protocols");
    live = info.live;
  } catch {
    live = false; // static hosting; the mock does the whole job
  }
  $("mode").textContent = live
    ? "A key is configured on the server, so live calls are available. The mock is still the default."
    : "Running entirely in this page on the deterministic mock — no key, no cost, nothing sent anywhere. Every path works, including the failures.";
  if (!live) {
    ($("provider") as HTMLSelectElement).querySelector<HTMLOptionElement>('[value="openai"]')!.disabled = true;
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
    void turn({ action: "submit", input: picked?.value ?? range?.value ?? typed?.value ?? "" });
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

  /* ── The stage area: what this screen asks the participant to DO ──────── */

  const choices = (s.choices ?? [])
    .map(
      (c, i) => `<label class="card-choice${i === 0 ? " picked" : ""}">
          <input type="radio" name="choice" value="${c.index}"${i === 0 ? " checked" : ""} />
          <span class="who">${escapeHtml(c.persona)}</span>
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
           <textarea id="input" rows="1" placeholder="Type as the participant would\u2026"></textarea>
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

async function turn(payload: { action: string; input?: string }): Promise<void> {
  // Ignore a second click while a call is in flight: double-submitting a turn
  // is how a participant ends up paying for two interviews of themselves.
  if (busy) return;
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
    const wantsLive = ($("provider") as HTMLSelectElement).value === "openai" && live;
    const online = ($("online") as HTMLInputElement).checked;

    $("calls").querySelector("tbody")!.innerHTML = "";

    if (wantsLive) {
      // The server holds the key and makes the call.
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

    // In-page, on the mock. Identical protocol, identical runner.
    localCalls = [];
    const gateway = new Gateway({
      adapters: [new MockAdapter()],
      onCall: (call) => {
        const at = localCalls.findIndex((c) => c.callId === call.callId);
        if (at >= 0) localCalls[at] = call;
        else localCalls.push(call);
      },
    });
    const protocol = onMock(protocols.find((p) => p.key === key)!);
    localRunner = new NarrativeRunner(
      protocol,
      { sessionId: `lab_${Date.now().toString(36)}`, variables: { first_name: firstName, topic }, online },
      gateway,
    );
    $("providerBadge").textContent = "provider: mock (in this page)";
    render({ screen: localRunner.start(), records: localRunner.all, calls: localCalls });
  })();
});

void detectServer();
