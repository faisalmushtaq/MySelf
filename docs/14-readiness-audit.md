# MySelf — research-readiness audit

Audited 2026-09-26 against `claude/myself-code-audit-ub9yhx` at `b848ec8`.
Verified by reading the code, not the documents: install, build, typecheck and
the full test suite were run, and every claim below cites the file it came from.

> **This document is the audit as found.** It is deliberately not rewritten as
> work lands, because a record of what was wrong is worth keeping. What has since
> been built, and what has not, is in **§8 — what changed after the audit** at
> the end. Read that before acting on anything above it. Operational
> instructions for fielding a study live in
> [15-fielding-runbook.md](15-fielding-runbook.md).

**Verdict.** The engineering is well above the norm for a research platform.
The definition layer, the survey engine, the release gate, the Firestore rules,
the relay's authorisation model and the BIDS export are all genuinely good, and
the test suite is real. What is not ready is the **route from a child's answer
to a researcher's dataset**, and the **promises the consent screen makes that
no code can keep**. Both are small, bounded pieces of work. Neither is a
rewrite.

Two days is enough to field a **survey-only** study safely. It is not enough to
field the micro-narrative module — see §4.

---

## 1. What is already sound

Worth stating plainly, because the rest of this document is a list of problems
and that would give a false impression of the whole.

| Area | State |
|---|---|
| Build, typecheck, tests | All green. 448 tests across 13 packages; `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` all exit 0. |
| Definition layer | `packages/schema` + `packages/library` + `packages/release`: instruments, scales, scoring and compositions are versioned, content-hashed and frozen into manifests. A sitting is read back through the release it was collected under (`apps/functions/src/releases.ts`). This is the part that is hardest to retrofit and it is done. |
| Survey engine | `packages/engine` is pure and separately tested (33 tests), including a consistency checker. |
| Relay authorisation | `apps/functions/src/relay-policy.ts` is the best-designed file in the repo. A caller sends a config *key*, never a model or a temperature; a device may only run configs a published release froze; a signed-in token is not a permission without a granted role; there is a per-caller daily call ceiling and a provenance row per call. |
| Firestore / Storage rules | 178 + 56 lines, exercised against the real emulator from both sides of every rule in CI (`.github/workflows/ci.yml`, `rules` job). Audio is written to a prefix no client can read. |
| Region and residency | `europe-west2`, set in the one module every function imports, and asserted by `deployment.test.ts` — with a comment explaining the import-ordering trap that made it silently fail before. |
| Identity separation | Names, DOB, UPN and NHS numbers live in a *separate Firebase project* reached only by a server-side credential, with every crossing logged (`apps/functions/src/apps.ts`). This is the right design and stronger than most studies manage. |
| Export | `packages/store/src/bids.ts` emits a real BIDS phenotype dataset: one TSV per instrument with a sidecar JSON dictionary, `participants.tsv`, `dataset_description.json`. Readable in thirty years. |
| Idempotency | `saveSitting` is idempotent by construction, writes chunks before parents, and quarantines rather than overwrites when the same session arrives from two devices (17 tests). |
| Code comments | Unusually good. Several comments document a bug that was found and why the fix is shaped as it is. That is how a platform stays correct after the person who wrote it moves on. |

---

## 2. Blockers — a study cannot be fielded until these are built

### 2.1 The consent screen promises a withdrawal the platform cannot perform

`packages/library/src/modules.ts:141` asks every participant to agree that:

> "if I choose to withdraw my data by contacting the primary researcher within
> 24 hours of submission (up until {withdrawal_date}) … my responses will be
> removed from the dataset and not used for analysis"

There is no code anywhere in the repository that removes a participant's data.
No delete path on the device, none in `apps/functions`, none in `apps/api`,
none in the researcher view. `grep -ri "erasure\|deleteParticipant\|purge"`
returns nothing but a `retention_note` string field.

This is the most serious finding in the audit. It is not a missing feature; it
is a statement made to a child, under an ethics reference, that the system is
not built to honour. `apps/functions/src/transcribe.ts` even names deletion as
"the operation that actually matters" — and then does not implement it.

### 2.2 There is no working path from a device to the server

Two backends exist, and the one the participant app talks to is not deployed.

- `apps/participant/src/lib/sync.ts:159` POSTs to `<endpoint>/sync/batches`
  with an opaque 32-char bearer token, and expects
  `{batchId, accepted, quarantined, ackHash, duplicate}` back. That contract is
  served **only** by `apps/api` — Fastify + Postgres + Keycloak, described in
  `docs/12-server-deployment.md`, with `infra/Dockerfile.api` and
  `infra/docker-compose.yml`. **No workflow deploys it.**
- `apps/functions/src/sittings.ts:246` (`saveSitting`) is the path that *is*
  deployed, and it speaks a different protocol entirely: a Firebase ID token or
  `Link` credential, body `{deviceId, sittings[]}`, response `{stored, outcomes}`.

The two cannot talk to each other. The participant app's sync panel — endpoint
field, token field, retry backoff, quarantine states, acknowledgement checksum
verification, all of it carefully built and tested — points at nothing in the
deployed system. The only working route off an iPad is the manual file
handover, exactly as `apps/participant/src/lib/export.ts` says: *"Until sync
exists, the route from a device to the dataset is a file."*

The researcher view makes this worse: it has **no Firebase dependency and no
authentication at all** (`apps/researcher/package.json`), so it cannot read the
server either. The nightly BIDS export lands in Cloud Storage where only
someone with console access can fetch it.

### 2.3 Nothing can be deleted from an iPad

`apps/participant/src/lib/export.ts` ends: *"the device copy is only deleted
once the transfer has been confirmed."* No code deletes it. There is no wipe,
no per-session delete, no post-handover clear anywhere in the app.

Consequences in a real school day:

- One iPad accumulates every child's answers for the entire study.
- The only way to clear it is to delete the PWA or clear Safari data — which
  also destroys the AES device key in IndexedDB, making **any unexported
  sitting permanently unreadable**.
- A device that goes missing carries the whole cohort, not one sitting.

### 2.4 The researcher view holds identifiable children's data in the clear

`apps/researcher/src/lib/db.ts:34` defines `PersonRecord`: given name, family
name, date of birth, UPN, NHS number. Stored in browser IndexedDB via Dexie
(`db.ts:94`) with **no encryption, no passphrase, no lock, no timeout, and no
sign-in on the app**. `db.ts:402` exports it all as a plaintext CSV.

The participant app encrypts its payloads at rest with AES-GCM
(`apps/participant/src/lib/crypto.ts`). The researcher app — which holds
strictly more sensitive data — does not. The local `identityAccess` audit log
(`db.ts:245`) is real, but it lives in the same database it is auditing and
clearing site data erases it.

### 2.5 The handover file is plaintext, and honestly says so

`downloadExport` writes unencrypted JSON of every response. The comment is
candid about it ("goes to approved storage, not a personal folder"), which is
better than pretending, but a file of children's mental-health responses moving
between an iPad and a laptop by AirDrop or USB with no encryption is a finding
a DPIA reviewer will stop on.

---

## 3. Governance items that block fielding but are not code

- ~~**Instrument licences are attested, not documented.**~~ **Withdrawn — this
  finding was wrong.** The permissions are held and filed; the records simply had
  not been updated since they were first encoded from the QSF on 2026-08-02, so
  they still carried `verified: false` and holder notes reading "(to document)"
  and "attested held". That is stale metadata, not a missing licence, and it was
  read here as the latter. Corrected in `packages/library/src/instruments.ts` and
  published as **r7.0.1** — a PATCH, because docs/06 §47 names a licence-status
  update as exactly that. Nothing a participant reads or selects differs from
  r7.0.0.

  What remains true, and is worth keeping: the release gate
  (`packages/release/src/builder.ts:307`) gates on `status`, not `verified`, so a
  green release has never been evidence about the paperwork either way. That is a
  reasonable design — code cannot check a filing cabinet — but it means the
  licence register is the record, not the manifest.
- **The identity Firebase project is not in any deploy pipeline.**
  `infra/firebase/identity.rules` exists (65 lines, correctly narrower than the
  research project's) but `infra/firebase/firebase.json` declares one Firestore
  target and `firebase.yml` deploys one project. The `IDENTITY_SERVICE_ACCOUNT`
  secret has no configuration path in the repo. Until both exist,
  `captureIdentity` and `lookupParticipant` throw at runtime — deliberately,
  per `apps.ts`, rather than falling back — so identity capture is unavailable
  in the field and must be either stood up or explicitly switched off.
- **Zero-retention with OpenAI is a note, not a setting.**
  `packages/narrative/src/protocols.ts` records `"zero-retention endpoint
  requested"` and `region: "eu"`; `packages/llm/src/adapters/openai.ts:43`
  sends neither. A ZDR arrangement is an org-level agreement with the provider,
  and nothing in the repo evidences one.
- **`gpt-4o`** is the model in every protocol. Fine technically; dated for a
  2026 fielding and worth a deliberate choice rather than an inherited one.

---

## 4. The micro-narrative module is not fieldable in two days

The LLM half of the platform — the thing the README leads with — is not wired
into anything a participant will see. Four independent reasons, any one of
which is sufficient:

1. **It is not in the questionnaire.** The frozen r7.0.0 composition contains
   zero occurrences of the string `narrative`.
   `packages/release/src/compose-ybm.ts:11` says so outright: *"The
   micro-narrative section (np.micro_narrative, D-15) is added when the protocol
   content is authored."* It never was. `NarrativeStep.tsx` is unreachable code
   in the shipped build.
2. **No model config is published.** `narrativeProtocols` and `modelConfigs` in
   r7.0.0 are both empty objects, so `releasedConfigs` in
   `relay-policy.ts` is empty, so `configFor` refuses **every** device call by
   design. A fielded iPad cannot make a model call at all.
3. **The module is not pointed at.** `MYSELF_MYSTORY_URL` is never set in
   `.github/workflows/pages.yml`, so `__MYSTORY_URL__` is `""` and a narrative
   position would render "this build has no module".
4. **iPads cannot sign in.** `apps/mystory-lab/web/session.ts:73` uses
   `signInWithPopup` with `browserSessionPersistence`. Popups do not work in an
   iOS standalone (Add-to-Home-Screen) PWA. The last four commits on `main`
   (#91, #92, #93, then #94 reverting all three) were attempts at this and were
   abandoned — so this is a known-open defect, not a discovery.

There is one piece of good news buried here. **The fix for (4) already exists
in the backend.** `apps/functions/src/admin.ts:71` — `enrolDevice` already
returns a Firebase **custom token**. `signInWithCustomToken` needs no popup and
works in a standalone PWA. Enrolling a device during handover, signing in with
that token, and passing the resulting ID token to both the relay and
`saveSitting` would close the sign-in defect *and* §2.2 with one mechanism. It
is the right target — just not a two-day one alongside everything else.

### Additionally: the two real protocols cannot be released

Six of eight files in `protocols/` have no `safeguarding_declaration` and no
safeguarding rules — including `brain_health.toml` and `overdiagnosis1.toml`,
which are the two that read like actual studies. Per
`packages/narrative/src/config.ts:183` they load as `NOT STATED` and fail the
release gate, correctly. With no rules, the distress lexicon never runs for
them either.

### And a safeguarding flag reaches nobody

`packages/narrative/src/runner.ts:563` raises a `safeguarding_flag` record with
a tier of `team_notification` or `safeguarding_review`. It is stored. Nothing
reads it: there is no email, no notification, no trigger, no researcher-view
queue — `grep -rn "sendMail\|nodemailer\|notify\|webhook"` across `apps/` and
`packages/` returns nothing. The `reviewers` field on the rule is never
consumed. A child disclosing self-harm produces a Firestore document that no
human is told about.

---

## 5. Testing gaps

The 448 tests are real and well-written, but they are all unit-level and they
stop exactly where the risk starts.

| Surface | Lines | Tests |
|---|---|---|
| `apps/mystory-lab/web/main.ts` — the child-facing chat | 3,051 | **0** |
| `apps/participant/src/components/*.tsx` — every screen a child touches | 1,767 | **0** |
| `apps/researcher/src/components/*.tsx` | 2,253 | **0** |

`apps/participant/vite.config.ts` sets `environment: "node"` and includes only
`src/**/*.test.ts`, so no component renders in any test. `playwright-core` sits
in the root `package.json` as a dependency **nothing imports** — there is no
end-to-end test of the app at all, on any browser, offline or online. For an
offline-first iPad PWA whose failure mode is "a child's morning is lost", that
is the gap most likely to cost real data.

Smaller: `pnpm -r lint` exits 1 — no package defines a `lint` script, so the
root script is decorative and CI does not run it.

---

## 6. What to build in two days

Scoped to **one or two developers, survey-only fielding, Firebase as the
backend**. The narrative module is explicitly out of scope; see §4.

### Decision to make before any of it — 30 minutes

**Pick one backend and delete or park the other.** Firebase is the answer: it
is deployed, region-correct, rules-tested in CI, and already has the relay,
transcription, nightly export and identity separation. `apps/api` is 1,734
well-tested lines that no deployed thing calls, and keeping both is precisely
what produced §2.2. Move it to a branch or mark it unused in the README —
leaving it importable invites the next person to wire the wrong half.

### Day 1

**1. Withdrawal and erasure — 4h. (§2.1, the highest priority item in this audit.)**
An owner-only callable that, given a participant code, deletes the session
documents and chunks, the narrative runs, the audio prefix, and the identity
record; writes an audit row naming who did it and why; and is exercised by a
test that asserts the data is gone from every one of those places. Then a
button for it in the researcher view. Without this the consent form is untrue.

**2. Device wipe after confirmed handover — 3h. (§2.3)**
In the handover panel: export, then an explicit "the file is saved and checked"
confirmation, then delete those sessions' rows and events. Per-session, never
"clear everything", and never able to delete a sitting that has not been
exported. Include a plain count of what is still on the device, which
`countStoredSessions` already computes.

**3. Tell the truth about sync — 1h. (§2.2)**
Remove or clearly disable the sync configuration UI in the participant app
until it points at something real. A panel that reports "sync failed, will
retry" for an endpoint that cannot exist will be read as a transient problem
for as long as it takes someone to lose a day's data trusting it. The file
handover becomes the documented, only route, and §6/Day 2 item 6 makes it safe.

### Day 2

**4. Lock the researcher view — 4h. (§2.4)**
Reuse `apps/participant/src/lib/crypto.ts`: derive a key from a researcher
passphrase with PBKDF2 and seal the `people`, `assignments` and `relationships`
tables; lock on load and after idle; move the access log out of the database it
audits, or at minimum append-only with a count the UI shows. Gate the identity
CSV export behind the same passphrase and a typed justification, which the
audit hook at `db.ts:245` already records.

**5. One end-to-end test — 3h. (§5)**
`playwright-core` is already installed. One WebKit run: enter a code, walk the
whole questionnaire, go offline mid-way, reload, confirm the session resumes
with every answer intact, finish, export, and confirm the file parses as
`myself.device.export.v1`. This single test covers more of the real failure
surface than any ten unit tests you could add, and it is the test that would
have caught the service-worker scope bug the vite config describes.

**6. Encrypt the handover file — 1h. (§2.5)**
Wrap the export in AES-GCM under a study passphrase, with the researcher view
prompting for it on import. Twenty lines using the primitives that already
exist, and it turns a loose USB stick from an incident into a non-event.

### Left undone, deliberately, and what it costs

| Not built in two days | Consequence |
|---|---|
| Device→server sync (§2.2) | Every iPad is handed over by file, by hand, at the end of each day. Workable; `saveSitting` is idempotent and waiting, so this is additive later. |
| Micro-narrative fielding (§4) | Survey-only study. The narrative module stays a lab tool for signed-in researchers. |
| Safeguarding notification (§4) | Acceptable **only** because no narrative runs in front of a participant. The moment one does, this becomes the first blocker, ahead of everything in §6. |
| Identity project stand-up (§3) | Identity capture off; participant codes only. The researcher view's local code-correction machinery covers a mistyped code. |
| Component tests (§5) | Known debt. The Day 2 end-to-end test is the floor, not the target. |
| Instrument licences (§3) | **Withdrawn** — the permissions are held. See the correction in §3. |

---

## 7. Two things worth fixing whenever the file is next open

Neither is a blocker; both are cheap and both are traps.

- `.github/workflows/pages.yml` deploys to the live GitHub Pages site on
  pushes to `main` **and** to `claude/myself-research-platform-foztm1`, which
  still exists on the remote. Two branches publishing to one URL means whichever
  pushed last is what an iPad in a school hall loads, with nothing on screen to
  say which. Narrow it to `main` before anything is fielded.
- `apps/mystory-lab/web/main.ts:2416` saves the in-progress narrative run — a
  child's own words — to **plaintext `localStorage`**, deliberately chosen over
  `sessionStorage` so it survives the tab closing. On a shared iPad that is the
  one storage that outlives the child. Whatever guard restores it needs a test
  that proves the next participant cannot be shown the previous one's
  conversation.

---

## 8. What changed after the audit

Everything below landed on `claude/myself-code-audit-ub9yhx` after the audit
above was written. Withdrawal was taken out of scope by the researcher, to be
handled manually; the micro-narrative module stays deferred.

### Built

**Multi-iPad integrity (§2.2's hard half).** `conflictWith` in
`packages/firebase/src/layout.ts` is now the single decision point, with four
rules rather than two, and `storeSitting` has none of its own. Two of the four
were silent data loss:

- a log that had got **shorter** overwrote the longer copy, because the parent
  document is replaced outright and unused chunks are deleted — so a device
  restored from a backup, or one re-sending a checkpoint after the full sitting
  had arrived, truncated a complete log with a successful response and nothing
  downstream able to tell;
- a **differing release hash** from the same device overwrote silently;
  `conflictWith` had the rule and nothing called it.

It also decides whether the *stored* copy is suspect, which is the difference
between flagging a genuine ambiguity and dropping a complete sitting out of the
export to punish a bad retry. The decision now happens **inside a transaction**,
because read-then-decide-then-write let two iPads handed over at the same moment
both read "nothing stored" and the second overwrite the first.

**A device→server path that exists (§2.2).** The participant app posts to
`saveSitting` as an enrolled device. `enrolDevice` already returned a Firebase
custom token and nothing called it — `signInWithCustomToken` needs no popup, so
it works in a Home Screen web app, which is what the four reverted sign-in
commits on `main` were failing to do. A sitting is confirmed only when the
server reports back that it stored **every event the device sent**; a 200 is not
an answer.

**Half-finished sittings are uploaded (new).** Before, the only sittings the
study ever held were the ones that reached the end, so an abandoned sitting, a
flat battery or a dropped iPad was a morning nobody had a record of. A checkpoint
every two minutes bounds that. It never moves the sitting out of `in_progress`,
and it is silent.

**A device can be cleared (§2.3).** `forgetConfirmedSessions` cannot reach an
unconfirmed sitting: it selects on state, on a receipt existing, and on the
receipt's count matching what is on the device now. The rule is a pure function
tested from the wrong side of every clause.

**The researcher view reads the study (§2.2's other half).** Directly, under the
`read: if isPerson()` rule that already existed. A pulled copy supersedes a
shorter local one — the file import's "duplicates add nothing" rule would have
left a partial sitting in the analysis for the rest of the study.

**Devices needed enrolling, then did not.** `enrolDevice` had no caller anywhere,
so the sync path was unusable however correct it was; a panel was added, and then
the whole requirement was dropped in favour of a device that signs itself in. What
survives is `revokeDevice`, which matters more under an open model than it did
under a closed one.

**The researcher view's names are locked (§2.4).** Sealed under a study
passphrase held only in memory, with a verifier so a wrong passphrase is reported
as wrong, and an auto-lock after fifteen minutes hidden. Nothing got slower: the
`familyName` and `upn` indexes were declared and never used, which is why this
was a small change. The lock is on the linkage tab alone — sittings carry codes
and no names, so the overview, table and export work locked.

**The handover file is encrypted (§2.5).** PBKDF2 at 600k iterations, fresh salt
and iv per file, under the study passphrase. Only the timestamp and sitting count
stay in the clear. Losing the passphrase is recoverable, because exporting
removes nothing from the device — which is what makes it the only format rather
than an option for careful days.

**An end-to-end suite (§5).** Five tests that walk the whole questionnaire in a
real browser, cut the network mid-sitting, reload and resume, and read the
encrypted file back. CI runs Chromium and WebKit; WebKit is the one that matters.
Now 541 unit tests and 5 end-to-end.

**§7's two traps.** Pages deploys from `main` alone. The root `lint` script is
gone rather than always failing.

**Devices log themselves in, offline (§8's second correction).** Anonymous Firebase
sign-in replaced the pasted token, and then was itself replaced: it needed a network
round trip before a device had any identity, a project-level switch somebody had to
find, and the whole Auth SDK inside a bundle whose first job is to work offline. An
iPad now issues its own credential at first launch — an id and a secret, generated
before it has ever reached the network — and the first upload registers the secret's
hash. First writer wins permanently, so an installation cannot be taken over, which
is what the no-overwrite rule needs from an identity. The participant bundle dropped
to 143 KB gzipped and there is no console switch at all.

**No device registration (§8's own correction).** An earlier version of this work
had an owner mint a token per iPad and a researcher paste it in. That is a barrier
in front of the one thing the platform exists to do, and it was removed: any iPad
with the study's URL collects and files sittings, signing itself in anonymously on
first upload. The integrity rules are unaffected, because the identity is still
server-issued and unspoofable — it is just created without asking anyone. The
relay and the transcriber stay closed to anonymous callers, since a model call
spends money and filing a sitting does not.

The cost is honest and stated in the runbook: **the write endpoint is open to
whoever has the URL.** Mitigations are a per-device upload ceiling, an `enrolment`
field on every sitting so an open-URL one can be told from a registered one, and
revoking a specific device. App Check is the real control if the URL circulates
further than intended, and it is a project setting rather than a code change.

### Found by the new test, and fixed

**The app reloaded itself under a participant.** `main.tsx` reloaded on every
service-worker `controllerchange`, unconditionally, and that fires in two
situations that are not "a new build arrived":

- on a device's **first ever load**, so the first participant on every new iPad
  was returned to the start screen with the code field empty moments after
  tapping Start;
- **mid-sitting**, whenever a deploy landed, because the registration is polled
  every sixty seconds and the update was applied at once — so a child answering
  question forty was put back on the code screen.

Neither lost data, because a sitting is resumable, and both look exactly like the
app crashing with a researcher at the front of the room. A build now waits for
the start screen, and a first install does not reload at all.

This is the defect the audit predicted from having no browser-level test, and it
was found within an hour of there being one.

### Still not done, deliberately

| Not built | Consequence |
|---|---|
| **Withdrawal / erasure (§2.1)** | Handled manually by arrangement. The consent form promises removal within 24 hours, so whoever fields the study must be able to honour that by hand and record it. Still the largest open risk in this document. |
| **Micro-narrative fielding (§4)** | Survey-only study. The module stays a lab tool for signed-in researchers. |
| **Safeguarding notification (§4)** | Acceptable **only** because no narrative runs in front of a participant. The moment one does, this is the first blocker, ahead of everything else. |
| **Safeguarding declarations on `brain_health.toml` and `overdiagnosis1.toml`** | Those protocols still cannot pass the release gate. |
| **Identity project stand-up (§3)** | `captureIdentity` and `lookupParticipant` still throw. Identity capture is unavailable server-side; the researcher view's local linkage covers a mistyped code. |
| **Component tests (§5)** | The end-to-end suite is the floor, not the target. The React components still have no unit tests. |
| **`apps/api`** | Still present and still called by nothing. Firebase is the backend. Parking or deleting it is a decision, not a task. |
| **mystory-lab's plaintext `localStorage` (§7)** | Untouched, because nothing fields the narrative module. Before it is fielded, it needs a test proving the next participant cannot see the previous one's conversation. |

---

## 9. Hardening after the first fielding pass

Written after the audit's §8 work, while stress-testing for the conditions a school
actually provides. Everything here was found by a test that did not exist before.

### Found and fixed

**A failed write to the device was swallowed.** `record` is invoked as `void
record(...)`, so a rejected IndexedDB write went nowhere: the answer stayed in the
in-memory store, "Saved" never appeared, and the participant carried on. On an iPad
low on space — or one whose database iOS had evicted under storage pressure — that
produced a sitting with gaps that **nothing downstream could detect**. This is the
worst failure the platform can produce, because a sitting that stopped is visible and
a sitting missing answers is not. The survey now stops on a failed write, refuses to
be advanced past it, and asks for a person.

**The retry ceiling was an hour.** Right for a background job on a server, wrong for a
six-hour school day: a device that had backed off had effectively stopped trying for a
sixth of the study. Ten minutes.

**Wifi returning was waited out.** A backoff is a guess about how long a problem will
last, and the network coming back is evidence the guess is stale. A device that had
backed off to ten minutes would sit on a hall's newly working wifi holding a child's
answers. The scheduled waits are now dropped on the online transition and the queue is
attempted at once; the attempt count is kept, so a genuinely broken endpoint still
backs off from where it was.

**Finished sittings waited for the start screen.** A class of thirty is continuous
handovers, so earlier participants' sittings could be held until the end of the
morning. The two-minute tick now drains the finished queue as well as checkpointing
the sitting in progress.

**The wire format was described three times** — in the function, in the participant
app, and in `@myself/store` — with nothing making them agree, and they had already
drifted (an event payload was `unknown` on the client and an object in the contract).
One definition now, imported by both ends, so a breaking change fails to compile on
the side that did not change.

### Verified, not assumed

| What | How |
|---|---|
| The dataset says what the participant answered | `e2e/accuracy.spec.ts` walks the questionnaire recording every visible stem and option label tapped, exports, decrypts, and resolves each stored code back through the release manifest. An off-by-one in an option list fails here and nowhere else. |
| Two iPads cannot overwrite each other | Real Firestore. Six devices racing for one session id settle on exactly one winner; six racing to claim one installation id likewise. |
| A retry overlapping itself | Three concurrent uploads of a 200-event sitting leave it intact and in order. |
| A checkpoint racing the finished sitting | The complete copy is what stays stored. |
| A captive portal | Refused rather than mistaken for a successful upload — the failure mode that would otherwise have a device delete data nobody holds. |
| Dropped connections, hangs, truncated replies, nine gateway statuses | None may end with a sitting marked confirmed. Each case asserts exactly that. |
| A 900-event sitting | Spills into chunks and reads back whole. |
| Twenty sittings at once | Keep their own lengths and their own participant codes. |

582 unit tests, 23 integration tests against a real Firestore, 6 browser tests.

### Still open

Unchanged from §8: withdrawal is manual, the narrative module is deferred (and
safeguarding notification with it), the identity Firebase project is not stood up,
`apps/api` is unused, and the React components have no unit tests beneath the
end-to-end suite. The WebKit half of the browser suite has never run here, because
only Chromium is installed in this container — CI is where it gets its first
exercise, and WebKit is the engine an iPad actually uses.
