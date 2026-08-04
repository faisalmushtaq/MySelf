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
  const modelWrote = s.kind === "follow_up" || s.kind === "interpret";

  $("screen").innerHTML = s.finished
    ? '<p class="stem">Finished.</p>'
    : `${modelWrote ? '<span class="badge model">written automatically</span>' : `<span class="badge">${s.kind}</span>`}
       <p class="stem">${s.text ? escapeHtml(s.text) : "<em>(this stage shows nothing)</em>"}</p>
       ${s.lede ? `<p class="lede">${escapeHtml(s.lede)}</p>` : ""}
       ${s.expectsInput ? '<textarea id="input" placeholder="type as the participant would"></textarea>' : ""}`;

  $("fallbackNote").innerHTML = s.fallback
    ? `<div class="alert"><strong>Fallback applied:</strong> ${escapeHtml(s.fallback.reason)} →
       <code>${escapeHtml(s.fallback.applied)}</code>. Nothing the participant said was lost.</div>`
    : "";

  $("controls").innerHTML = s.finished
    ? ""
    : `${s.expectsInput ? '<button class="primary" id="send">Send</button>' : '<button class="primary" id="cont">Continue</button>'}
       ${s.optional ? '<button class="secondary" id="skip">Skip this one</button>' : ""}`;

  document.getElementById("send")?.addEventListener("click", () => {
    void turn({ action: "submit", input: (document.getElementById("input") as HTMLTextAreaElement).value });
  });
  document.getElementById("cont")?.addEventListener("click", () => void turn({ action: "next" }));
  document.getElementById("skip")?.addEventListener("click", () => void turn({ action: "skip" }));

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

async function turn(payload: { action: string; input?: string }): Promise<void> {
  if (localRunner) {
    const screen =
      payload.action === "next"
        ? await localRunner.next()
        : payload.action === "skip"
          ? await localRunner.skip()
          : await localRunner.submit(payload.input ?? "");
    render({ screen, records: localRunner.all, calls: localCalls });
    return;
  }
  render(await api<Frame>("/api/turn", { sessionId, ...payload }));
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
