# MySelf — Risks, Staged Plan, Prototype, Decisions Required

## 1. Principal risks and mitigations

| Domain | Risk | Mitigation |
|---|---|---|
| Platform | iPadOS evicts PWA storage / quota surprises | Home-Screen install mandatory; `persist()`; lean bundles; sync ritual + unsynced banners; encrypted backup export; Capacitor wrapper as pre-abstracted fallback; **physical-iPad pilot before any real collection** |
| Platform | No background sync on iOS | Foreground sync on launch/connectivity/manual; researcher end-of-day procedure; never claim background behaviour |
| Data integrity | Loss between collection and sync | Append-only events, transactional writes, checksums, server-ack-before-purge, quarantine instead of merge/discard, backup export |
| Psychometric | Deviations already present in YBM (SDQ anchors/wording mix, KSS typo, EHI anchors, 0–10 ladders) contaminating future waves | As-administered forms preserved as explicit versions; canonical forms only adopted by researcher decision; MAJOR-version rule for any participant-visible change |
| Psychometric | Presentation change (matrix → stepped) altering measurement properties | Per-form fidelity flag forces grid where required; A/B comparability check in an early wave recommended before committing |
| Licensing | SDQ electronic administration unauthorised (**verified risk — youthinmind requires authorisation/fees**); SWEMWBS unregistered; STAI-5 status unclear; doomscrolling items unattributed; hair-chart image rights | Licence-status gate blocks publishing; contact youthinmind + Warwick registration + Mind Garden query before the YBM release is frozen |
| Ethics/safeguarding | Narrative disclosures (and RCADS item 18) without a defined route; risk of implying real-time monitoring | Tiered safeguarding config per protocol, ethics-approved wording, review-queue SLAs, explicit non-real-time disclosure to participants |
| Privacy | Identifiers beside responses (status quo) | Identity/research schema separation, team-issued codes, DoB removal (decision pending), PII-free exports by default, audited linkage service |
| LLM | Provider drift/retention/regional processing; prompt injection via participant text | Frozen model configs with provider-reported snapshot capture; retention/training flags recorded; minimisation; prompt-injection hardening (participant text always in data role, never system); provider-independent adapter keeps exit path |
| Delivery | Scope explosion (this brief is a multi-year platform) | Strict MVP vertical slice; deferred list; regression fixture keeps the core honest while features accrete |
| Ops | University-team maintainability | Boring, well-documented stack; Docker Compose dev; no exotic infra; runbooks for device loss/study closure/archiving |

## 2. Staged implementation plan (each phase gated by acceptance criteria)

**Phase 0 — Sources & decisions (blocked on inputs)**
Receive micro-narrative ZIP + QSF + ladder/hair images; researcher decisions on A-1…A-5, A-26/A-27, licensing contacts initiated; agree MVP protocol config.
*Accept:* decisions.yaml populated; unsupported-construct report empty or dispositioned; licences requested.

**Phase 1 — Definition layer & library (≈2–3 wks of focused work)**
`packages/schema` (all JSON Schemas), `packages/engine` core (state machine, logic AST, piping, validation), library encoding of YBM (all instruments incl. as-administered forms, modules, scales, scoring definitions), release manifest + hashing, publish gate CLI.
*Accept:* YBM composition validates; manifest hash reproducible; engine replays scripted fixtures headlessly with correct branching/codes; scoring matches hand-worked examples; unit coverage on engine ≥ 90 %.

**Phase 2 — Participant PWA offline (≈3–4 wks)**
Renderer for all YBM response types; autosave events; IndexedDB encrypted store; service worker + bundle provisioning + verification; session lifecycle + handover; status indicators; accessibility baseline; multi-session per device.
*Accept:* full YBM completion in airplane mode on a physical iPad incl. force-quit/restart recovery; axe-core clean; every brief §"Testing" offline case demonstrated on-device or explicitly documented as manual-protocol item.

**Phase 3 — Sync, Studio minimal, publish flow (≈2–3 wks)**
API + Postgres schemas; device enrolment; idempotent batch sync + acks + quarantine; Studio: library browser, composer, validation UI, publish + URL/QR, device provisioning, session monitor; auth + roles; audit log.
*Accept:* interrupted-sync/resume and duplicate-upload tests pass; two-device same-session quarantine works; publish produces immutable release reproducible from manifest; roles enforced in tests.

**Phase 4 — Exports & migration deliverables (≈1–2 wks)**
Long/wide/legacy exporters, codebook/dictionary generators, crosswalk, scoring syntax emitters, export audit; regression fixture finalised in CI.
*Accept:* fixture exports byte-stable; legacy round-trip identity test passes; export bundle reconstructs "what each participant saw" in a documented walkthrough.

**Phase 5 — Micro-narrative module (≈2–3 wks, after codebase audit)**
Protocol/prompt/model-config objects + composer integration; staged records; server LLM gateway + adapters + mock; queued offline generation; confirm/correct UI; safeguarding flags; full narrative test matrix.
*Accept:* `np.future_self@1.0` runs end-to-end online, offline-queued, and model-down; provenance rows complete per brief field list; original narrative provably immutable under reprocessing; researcher edits protocol config without code change → new version → new release required.

**Phase 6 — Hardening & iPad acceptance (≈1–2 wks)**
Physical-device protocol (install online → airplane-mode relaunch → full offline survey → force-quit recovery → device restart → consecutive participants → reconnect sync → interrupted sync → duplicate prevention → low storage → offline config-update attempt → version change between sessions → narrative queue resume → handover → backup export/restore), performance passes, dashboard flags v1, docs.
*Accept:* signed-off manual protocol on ≥2 physical iPads (one older model); all automated suites green; pilot-readiness review.

## 3. Smallest useful prototype (recommendation)

One iPad, one researcher, one afternoon: publish `ybm-nd2026-standard r1.0.0-rc` (with `np.future_self` in `continue_without_model` mode) → provision iPad in Studio device mode → airplane mode → three consecutive synthetic participants complete the full survey incl. narrative capture → reconnect → sync → export bundle → verify crosswalk + codebook + manifest + narrative provenance. This exercises every architectural risk (offline storage, handover, idempotent sync, immutable release, exports, narrative fallback) with the real survey — not a demo questionnaire.

## 4. Decisions that genuinely require your input before coding

> **✅ RESOLVED 2026-08-02.** All decisions were answered by the principal researcher and are recorded with dispositions in [`migration/decisions.yaml`](../migration/decisions.yaml) (D-01…D-15). Headlines: all five confirmed content/logic errors fixed in r1; RCADS/SDQ become soft-required honouring "you can skip it"; consent stays forced (off-platform decline handling); **canonical validated forms adopted in r1** (documented break; SDQ still licence-gated); identifier collection unchanged in-flow but stored via the separated identity schema; cloud hosting; **non-MDM team-controlled iPads** (app-layer encryption promoted to primary control); OpenAI adapter first behind the provider-independent gateway; **the full micro-narrative protocol is the MVP's narrative module** (no separate future_self protocol). Outstanding inputs (non-blocking for Phase 1): safeguarding protocol document, cloud account/IdP details, licence outcomes.
>
> The original question list is preserved below for provenance.

1. **Anomaly decisions:** A-1 (Abstaining_SM wording), A-2 (Twitch condition — confirmed live error), A-3 (inverted gaming logic — confirmed live error), A-5 (consent decline path), A-34 (bespoke typo fixes), **A-43** (age dropdowns missing "5"), **A-44** (RCADS/SDQ forced-response contradicts "you can skip it" — recommended: soft-required + explicit decline in r1, documented as an approved departure) — fix-in-r1 vs preserve, each recorded in `migration/decisions.yaml`.
2. **Identifier redesign approval** (A-26/A-27): drop names/DoB from the participant flow in favour of team-issued codes + identity-service capture? (Recommended.)
3. **Licensing:** confirm/initiate youthinmind authorisation (SDQ — blocking), Warwick SWEMWBS registration, STAI-5 position, doomscrolling-items source, hair-type chart image rights; **plus** contact the micro-narratives authors (petr.slovak@kcl.ac.uk) to confirm the reimplementation-with-citation plan for the narrative module (academic/non-commercial licence with community commitments — see docs/08 §8). Who owns these conversations?
4. **Comparability stance for r1:** administer the as-administered forms verbatim (typos included) for continuity with the current wave, or adopt corrected canonical forms now and accept a documented break? (Recommended: verbatim `-ybm-asadmin` forms in r1 alongside canonical forms in the library, switch by explicit decision at the next natural wave boundary.)
5. **Deployment target & IdP:** university VM vs cloud; which OIDC provider (Leeds Azure Entra?); NHS-adjacent requirements now or later?
6. **Safeguarding routes:** named reviewers, review cadence, escalation wording for RCADS-18 and narrative flags (needs ethics alignment; PSCETHS-1449 scope check).
7. **Managed-iPad posture:** are collection iPads MDM-managed with passcodes (assumed yes — required for the at-rest security story)?
8. **LLM provider + data-processing terms** for the first narrative study (provider, region, retention, training-use opt-out) consistent with consent and ethics. Note: the existing app is OpenAI-only; MySelf's gateway is provider-independent, so this is a study-level choice, not an architectural one.
9. **Second seed protocol scope:** should the MVP include the full `np.micro_narrative` protocol (collect→extract→three personas→select→rate→adapt, ported from the CHI 2025 app) alongside `np.future_self`, or is `np.future_self` alone sufficient for the vertical slice? (Recommended: specify both, implement `np.future_self` first, port the full protocol in Phase 5 as its acceptance test.)

## 5. Decisions taken since

### MyStory on any participant's iPad, under daily limits (2026-10-06, D-55)

**Decision (the research team's).** Any participant's iPad may use the model
for MyStory, with a daily cap. This reverses a documented security decision:
until now the relay, `transcribe` and `saveNarrative` refused the credential an
iPad issues itself (`Authorization: Device <installId>.<secret>`), which may
file a sitting but was never to buy a model call (`AuthOptions` in
`apps/functions/src/relay.ts`). The reason still holds — anyone with the survey
URL can register any number of new installations, because the first writer of
an installation id wins — so the reversal is bounded rather than open.

**Why it had to change.** No participant's iPad could run MyStory at all. Devices
are no longer enrolled (self-registration replaced it), a Home-Screen app cannot
sign in with a popup (docs/14 §4), and a tester link is for pilots. The survey
build did not even know where the module was: `MYSELF_MYSTORY_URL` was never set
in `pages.yml`, so a MyStory position said "not available on this device".

**How a participant's call is authenticated, end to end.**
1. The survey reads its device credential (`syncTarget()`, the one `saveSitting`
   already accepts) and sends it to the module by `postMessage`, **addressed to
   the module's origin**, in the same message as the protocol, each time the
   module says it is ready. **Never in the iframe URL.**
2. The module believes it only from the page that framed it, and only when that
   page's origin is one it trusts: its own (the survey and the module share
   `faisalmushtaq.github.io`) or one baked in at build time
   (`MYSELF_MYSTORY_HOST_ORIGINS`). It keeps it **in memory only**: never in
   storage, the URL, a record or a log. With it, the module does not ask anyone
   to sign in.
3. The module sends it as `Authorization: Device …` to the relay (through
   `RelayAdapter`), `transcribe` and `saveNarrative`. Each verifies it exactly as
   `saveSitting` does: first writer wins, and a device stopped by an owner
   (runbook §8) is refused.
4. A device runs only what a release froze. Its call must name the sitting's
   release hash, and the relay runs exactly the config that release froze
   (`configForCall`). Without a hash it is refused, so a device can never pick a
   shipped protocol's draft config or any other.
5. Then the two limits below, then the provider.

**Two limits, both needed.** Counted together in one Firestore transaction,
just before the provider is called, and counting only calls let through.

| Limit | Setting | Default |
|---|---|---|
| Model calls one iPad may make in a day | `MYSELF_RELAY_DEVICE_DAILY_LIMIT` | 120 |
| Model calls all iPads together may make in a day | `MYSELF_RELAY_DEVICES_DAILY_LIMIT` | 2,000 |

- A per-device limit alone bounds nothing, because a new installation is free.
  The study-wide ceiling is what bounds the day's spend.
- Days are UTC days. The counts are in `studies/{study}/audit_relayDevices`
  (`{day}` for the study, `{day}_{installId}` per iPad), beside refusals.
- **A transcription counts as one call** against both. It spends OpenAI money
  like a model call, and one counter is easier to reason about than two. The
  existing per-caller counter already treats them alike.
- **Why 120.** One conversation of the full protocols (`np.phone_wellbeing`,
  `np.micro_narrative_full`) makes one interviewer call to open and one per
  answer until the interview is done or hits its turn limit (14 and 12),
  usually 5–8; one extraction; three retellings; and one per revision asked
  for. Typed, that is usually 10–13 calls, and about 20 at the turn limit with
  two revisions. Speaking adds a transcription per recorded answer, up to about
  14 more, and a retried call counts again. So the heaviest conversation is
  about 40 calls and a typical one 12–15: 120 is three of the heaviest, or eight
  to ten typical ones, per iPad per day. An iPad that will carry more MyStory
  conversations than that in a day needs the limit raised (runbook §10).
- **Why 2,000.** About 150 typical conversations a day — more than a day of
  fielding at this study's size. At 1–3p a journey (docs/13 §6), a full day is
  a few pounds.

**When a limit is reached** the relay answers 429, `rate_limit`, not retryable
now, with `limit: "device"`, `"study"` or `"off"`, a message written for the
participant ("…It will be available again tomorrow."), and a `Retry-After` to
the next UTC midnight. The module shows it and tells the survey, which offers
the way past at once. Nothing already answered is affected; the sitting can
always be finished without MyStory.

**Switching it off without a code change.** Set either limit to `0`. Every
device call is then refused with a message saying MyStory is switched off;
researchers and tester links are unaffected. A value that is not a whole number
of zero or more also reads as `0`: a typo fails closed, not open. The settings
reach the functions as repository variables at deploy (runbook §10).

**`saveNarrative`** accepts the device credential too. A run is bound to
whoever first stored it: a run stored under one caller is never replaced by
another (the sittings' first-writer rule). A device cannot attach a run to a
sitting another device filed, and its run must name its release. It is stored
as `provenance: "study"`.

**The module's copy on the iPad.** The module keeps the run in progress on the
device so a reload does not lose it. Inside the survey it now restores only the
run of the sitting it was opened for, and drops any other. Before, the next
child on a shared iPad would have been shown the last child's abandoned
conversation the moment the module could run (docs/14 §7).

**Unchanged.** Researchers, devices enrolled with a `device` claim and tester
links keep their limits (600 calls a day per caller; a link's own cap) and their
config rules. A Firebase anonymous token still cannot buy a call. A Studio
preview never runs the module.

**What it costs at worst, said plainly.** The ceiling bounds the number of
calls, not their size. Each call is bounded by the relay's request shape and the
release's frozen output ceiling, but a crafted call can fill the model's context
window and cost tens of pence. A counted call is one request to the relay, which
may try the provider up to the release's `maxAttempts` (3) times when it times
out. So the worst day under the default ceiling is in
the hundreds of pounds, not unbounded. **The last line is the provider's**: set
a monthly budget limit and alerts on the OpenAI project before fielding.

**Not settled by this.** A safeguarding flag still reaches nobody (docs/14 §4),
and App Check is still the control for a URL that circulates too far (runbook
§2). Both come before MyStory is fielded with participants.
