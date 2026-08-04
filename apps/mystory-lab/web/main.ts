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

function render(frame: Frame): void {
  const s = frame.screen;
  currentKind = s.kind;
  const modelWrote = ["follow_up", "interpret", "collect", "adapt"].includes(s.kind);

  // The stages where the participant is choosing or rating need their own
  // controls: a list of retellings to pick between, or a 0-10 scale. Typing
  // an index into a text box is a developer's idea of an interface.
  const choices = (s.choices ?? [])
    .map(
      (c) => `<label class="choice">
          <input type="radio" name="choice" value="${c.index}"${c.index === 0 ? " checked" : ""} />
          <span><em>${escapeHtml(c.persona)}</em><br />${escapeHtml(c.text)}</span>
        </label>`,
    )
    .join("");

  const rating = s.rating
    ? `<div class="rating">
         ${Array.from({ length: s.rating.max + 1 }, (_, i) => `<label><input type="radio" name="rating" value="${i}"${i === s.rating!.max ? " checked" : ""} /><span>${i}</span></label>`).join("")}
       </div>`
    : "";

  /**
   * At the adapt stage the retelling is the participant's to rewrite.
   *
   * The original offers direct text editing alongside asking the model for a
   * change (§8.1), and the two are different data: a sentence a young person
   * typed is evidence in a way a model's reading of their instruction is not.
   * Everywhere else the retelling is quoted, not editable.
   */
  const shown = !s.scenario
    ? ""
    : s.editable
      ? `<label class="field-label" for="scenarioEdit">The write-up — change it here if you like</label>
         <textarea id="scenarioEdit" class="scenario-edit" rows="6">${escapeHtml(s.scenario)}</textarea>`
      : `<blockquote class="scenario">${escapeHtml(s.scenario)}</blockquote>`;

  const unchangedNote = s.unchanged
    ? `<p class="lede warn-text">The model could not make that change from your own words, so it left the
       write-up as it was. You can edit it yourself above.</p>`
    : "";

  $("screen").innerHTML = s.finished
    ? `<p class="stem">Finished.</p>${s.stopped ? `<p class="lede">Stopped: ${escapeHtml(s.stopped.reason)}</p>` : ""}`
    : `${modelWrote ? '<span class="badge model">written automatically</span>' : `<span class="badge">${s.kind}</span>`}
       <p class="stem">${s.text ? escapeHtml(s.text) : "<em>(this stage shows nothing)</em>"}</p>
       ${s.lede ? `<p class="lede">${escapeHtml(s.lede)}</p>` : ""}
       ${shown}
       ${unchangedNote}
       ${choices ? `<div class="choices">${choices}</div>` : ""}
       ${rating}
       ${
         s.expectsInput && !choices && !rating
           ? `<textarea id="input" placeholder="${
               s.editable ? "or tell me what to change and I will rewrite it" : "type as the participant would"
             }"></textarea>`
           : ""
       }`;

  $("fallbackNote").innerHTML = s.fallback
    ? `<div class="alert"><strong>Fallback applied:</strong> ${escapeHtml(s.fallback.reason)} →
       <code>${escapeHtml(s.fallback.applied)}</code>. Nothing the participant said was lost.</div>`
    : "";

  // At the adapt stage there are three things a participant can do, which is
  // what the original offers: keep their own edit, ask the model to rewrite,
  // or put back what was there before.
  $("controls").innerHTML = s.finished
    ? ""
    : `${
        s.editable
          ? `<button class="primary" id="keep">Keep my version</button>
             <button class="secondary" id="send">Ask for a rewrite</button>
             <button class="secondary" id="revert">Undo the last change</button>`
          : s.expectsInput
            ? '<button class="primary" id="send">Send</button>'
            : '<button class="primary" id="cont">Continue</button>'
      }
       ${s.optional ? '<button class="secondary" id="skip">Skip this one</button>' : ""}`;

  document.getElementById("send")?.addEventListener("click", () => {
    const picked = document.querySelector<HTMLInputElement>('input[name="choice"]:checked');
    const rated = document.querySelector<HTMLInputElement>('input[name="rating"]:checked');
    const typed = document.getElementById("input") as HTMLTextAreaElement | null;
    void turn({ action: "submit", input: picked?.value ?? rated?.value ?? typed?.value ?? "" });
  });
  document.getElementById("cont")?.addEventListener("click", () => void turn({ action: "next" }));
  document.getElementById("skip")?.addEventListener("click", () => void turn({ action: "skip" }));
  document.getElementById("keep")?.addEventListener("click", () => {
    const edited = (document.getElementById("scenarioEdit") as HTMLTextAreaElement | null)?.value ?? "";
    void turn({ action: "edit", input: edited });
  });
  document.getElementById("revert")?.addEventListener("click", () => void turn({ action: "revert" }));

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
  collect: "Thinking about what you said — if that was the last question, the write-ups take a few seconds…",
  extract: "Reading back over the conversation…",
  generate: "Writing the short versions — this takes a few seconds…",
  adapt: "Rewriting it the way you asked…",
  follow_up: "Thinking about what you said…",
  interpret: "Reading back over what you wrote…",
};

let busy = false;
/** The kind of stage on screen, so the waiting note can say what is coming. */
let currentKind = "introduction";

function setBusy(stageKind: string | null): void {
  busy = stageKind !== null;
  const controls = $("controls");
  controls.querySelectorAll("button").forEach((b) => (b.disabled = busy));
  const existing = document.getElementById("waiting");
  if (stageKind === null) {
    existing?.remove();
    return;
  }
  const note = existing ?? document.createElement("p");
  note.id = "waiting";
  note.className = "waiting";
  note.textContent = WAITING[stageKind] ?? "Working";
  if (!existing) controls.append(note);
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
            : payload.action === "edit"
              ? localRunner.editScenario(payload.input ?? "")
              : payload.action === "revert"
                ? localRunner.revertScenario()
                : await localRunner.submit(payload.input ?? "");
      render({ screen, records: localRunner.all, calls: localCalls });
      return;
    }
    render(await api<Frame>("/api/turn", { sessionId, ...payload }));
  } catch (error) {
    // A failed turn must not leave the page disabled and silent.
    $("screen").innerHTML =
      `<span class="badge warn">something went wrong</span>
       <p class="stem">${escapeHtml(String((error as Error).message ?? error))}</p>
       <p class="lede">Nothing you wrote has been lost — it is in the records below.</p>`;
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
