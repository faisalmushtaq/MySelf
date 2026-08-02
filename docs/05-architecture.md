# MySelf — Technical Architecture

## 1. Stack recommendation and rationale

**TypeScript monorepo** (pnpm workspaces):

```
apps/participant     React + Vite PWA (MySelf Go)
apps/researcher      React + Vite (MySelf Studio; includes on-iPad device mode)
apps/api             Node 22 + Fastify, REST + JSON Schema-validated payloads
packages/schema      Zod schemas → generated JSON Schema for all definition artefacts
packages/engine      Pure survey runtime: state machine, branching/piping evaluator,
                     validation, progress model. No DOM, no IO — runs identically
                     in browser, worker, and Node (tests, server-side re-simulation)
packages/scoring     Versioned scoring definitions + executor (+ R/py syntax emitters)
packages/export      Long/wide/legacy exporters, codebook & manifest generators
packages/llm         Provider-independent model interface + Anthropic/OpenAI adapters
                     + deterministic mock provider
packages/crypto      Key handling, checksums, envelope encryption helpers
```

**Why:** one language end-to-end means the *same* branching/scoring/validation code runs offline on the iPad and on the server — this is a reproducibility feature, not a convenience (no "client evaluated logic differently from the analyst's re-run"). React+Vite+Workbox is the best-supported PWA path; Fastify is small, fast, schema-first. Trade-offs: analysts prefer R/Python — addressed by first-class exports and generated scoring syntax, not by writing the platform in Python; NestJS offers more structure but more magic — Fastify + explicit modules is easier for a university team to maintain.

**Database: PostgreSQL 16.** Definitions stored as JSONB validated against published JSON Schemas; responses as append-only event rows; releases as content-addressed manifests. Why not a document DB: relational integrity across instruments/versions/releases/sessions is the core of provenance. Why not SQLite server-side: multi-user, roles, row-level security. (SQLite *is* used inside the encrypted backup export format.)

**Auth:** OIDC (university IdP / Azure Entra; Keycloak for dev) for researchers; short-lived access tokens + rotating refresh; role- and study-scoped permissions enforced server-side (row-level security on study_id). Participants never authenticate: sessions are created against a release, keyed by team-issued participant codes; managed-device mode is unlocked by researcher PIN + device enrolment certificate.

**Hosting:** containerised (Docker Compose for dev; any university VM/k8s for prod). No proprietary cloud services in the core path (S3-compatible object storage for assets/exports; Postgres; stateless API) → no vendor lock-in.

## 2. Definition layer (formal schemas)

Everything a participant can experience is data, validated by JSON Schema, never hard-coded UI:

- `instrument.schema.json` (+ forms: language, reading-level, informant)
- `item.schema.json` (stem, media refs, response-scale ref, presentation hints, accessibility text)
- `response-scale.schema.json` (options, codes, direction, labels)
- `logic.schema.json` (branching/display: a small, total, side-effect-free expression AST — `all/any/not/eq/ne/in/gt/…` over item refs, embedded fields; no arbitrary code)
- `scoring.schema.json` (inputs, transforms incl. code crosswalks, reverse-scoring, missing-data rules, outputs)
- `assessment.schema.json` (draft composition) → `release-manifest.schema.json` (frozen, hashed)
- `narrative-protocol.schema.json`, `prompt-template.schema.json`, `model-output.schema.json` (structured outputs)
- `export-manifest.schema.json`, `crosswalk.schema.json`

The **release manifest** embeds (or content-addresses) every instrument version, item version, scale, ordering, logic, piping, text, language/reading settings, scoring definitions, narrative protocol + prompt + model config + safety config, offline behaviour, and the engine version — then is SHA-256 hashed. The hash is the release's immutable fingerprint, printed in every export.

## 3. Offline-first participant runtime (iPad PWA)

### Storage
- **Cache Storage (service worker, Workbox):** app shell precached at install; release bundles (manifest + assets) cached explicitly at provisioning, then verified against per-file hashes from the manifest before the device reports "Ready".
- **IndexedDB (via Dexie):** `releases`, `sessions`, `events` (append-only response/paradata events), `narrative_queue`, `sync_state`, `device`. **Never LocalStorage** for research data.
- `navigator.storage.persist()` requested at provisioning; result surfaced in device readiness.

### Encryption at rest (honest scope)
- Per-device AES-GCM data-encryption key (DEK) generated at provisioning as a **non-extractable WebCrypto CryptoKey**, stored in IndexedDB (structured-clone of CryptoKey keeps it non-extractable); a wrapped copy (RSA-OAEP to the server's provisioning key) is escrowed server-side for recovery.
- Every event/session record is encrypted with the DEK before hitting IndexedDB; integrity via AES-GCM tag + per-record SHA-256 in an audit chain.
- **Limitation stated plainly:** iPadOS gives web apps no hardware keystore; a determined attacker with an unlocked device and developer tools can exfiltrate data the app itself can read. App-layer encryption defends against casual extraction, backups and cross-app snooping. Participant-owned devices: no research data retained after session sync (see §7).
- **Fleet posture (decision D-13):** collection iPads are team-controlled but **not MDM-managed**. App-layer encryption is therefore the **primary** at-rest control, hardened accordingly: short local retention after verified sync (default purge at verification, not 7 days), aggressive sync ritual, device-passcode presence surfaced on the readiness screen (best-effort detection; the provisioning runbook makes a passcode + Home-Screen install mandatory manual steps), and the escrowed-DEK revocation path is the loss/theft response. Residual risk (unlocked, passcode-less device in hostile hands before sync) is recorded in the risk register and mitigated procedurally, not cryptographically.

### iPadOS platform limitations and mitigations (do not assume desktop behaviour)
| Limitation | Consequence | Mitigation |
|---|---|---|
| No Background Sync / Periodic Sync API in Safari/WebKit | Cannot sync while app is closed | Sync on launch, on foreground, on connectivity events, and via visible "Sync now"; researcher workflow includes end-of-day sync ritual; unsynced-count banner |
| Storage eviction under pressure; 7-day ITP eviction applies to Safari-tab usage (Home-Screen installs are exempt from the 7-day rule but not from pressure eviction) | Data loss risk if the app is unused and storage-starved | Install-to-Home-Screen is required for collection devices; `persist()` requested; large free-space check in readiness; aggressive sync + encrypted backup export; retention warnings |
| Quota opaque (~several GB typically, not guaranteed) | Provisioning may fail on full devices | Readiness card shows estimated quota via `navigator.storage.estimate()`; bundles are lean (no video by default) |
| WKWebView/Safari kill background tabs freely | Mid-item state loss | Autosave *every* response event transactionally before advancing; app resumes to exact item on relaunch |
| No reliable clock guarantee | Paradata timestamp skew | Record monotonic timers per session + server time offset measured at each sync; never trust device wall-clock alone |
| Private Browsing blocks IndexedDB persistence | Silent failure | Detect and hard-refuse collection mode with a clear message |

**Fallback ruling (explicit):** ship as a pure PWA for the MVP pilot; the storage interface in `apps/participant` is abstracted so that, if physical-iPad pilots show unacceptable eviction or quota behaviour, the same app is wrapped in **Capacitor** (native SQLite + iOS Keychain via plugins) without rewriting application code. A fully native app is not justified: it would duplicate the entire definition-driven renderer for no additional research capability.

## 4. Sessions, events and the state machine

All participant data are **append-only events**: `response.recorded`, `response.changed`, `item.presented`, `item.skipped`, `item.declined`, `navigation.back`, `section.completed`, `session.completed`, `narrative.*`, each carrying ULIDs, session ID, release hash, item version ref, monotonic + wall timestamps. "Current answer" is a materialised view; **raw events are never updated or deleted**.

Session states (device-local, mirrored server-side):

```
not_started → in_progress → completed_locally → awaiting_sync → syncing
   → synced_verified → (retention policy) → purged_from_device
syncing → sync_failed → awaiting_sync (retry w/ backoff)
any → exported_backup (parallel flag, not a terminal state)
integrity check fails → quarantined (never silently dropped; researcher resolution)
```

Guards: double-tap/duplicate-submit protection via idempotent event ULIDs; interrupted-write protection via Dexie transactions (event + session-state updated atomically); resume picks the last consistent state; device clock changes detected via monotonic-clock discontinuities and flagged in paradata; duplicate participant-ID entry prompts researcher confirmation and never merges sessions silently.

## 5. Synchronisation protocol

- **Unit:** batch of encrypted events + session snapshots, identified by `batch_id = hash(device_id, session_id, first/last event ULID)` used as the idempotency key.
- Client → `POST /sync/batches` (TLS only; token from device enrolment). Server validates schema + integrity chain, upserts events by ULID (idempotent — replays are no-ops), then returns an **acknowledgement listing every accepted event ULID + server-side hash**.
- Client marks events synced only after verifying the ack hash; partial acks leave the remainder queued; interrupted uploads resume by batch (server keeps a receipt log).
- Session becomes `synced_verified` only when the server confirms all its events + a session checksum.
- **Conflicts:** true conflicts are designed out (events are append-only and device-unique). If the server sees the same session ID from two devices or a checksum mismatch, the session is **quarantined server-side with both copies preserved** and surfaced to the researcher — never auto-merged, never discarded.
- Local retention after sync: configurable per study (default: keep encrypted 7 days or until researcher-confirmed verification, then purge); deletion is an authorised action or an explicit policy, never an automatic side effect of upload.
- **Encrypted backup export:** device mode can export an encrypted container (AES-GCM, passphrase + escrowed key) of all local sessions via the share sheet — for when sync is impossible; import path on Studio validates and ingests idempotently (same event ULIDs).

## 6. LLM integration

- All model calls are **server-side** (`packages/llm` gateway). The client never holds provider keys; offline clients enqueue `narrative_jobs` locally, which sync like any event and are executed by the server queue **only if** the release's frozen consent/processing configuration permits it (consent gating is evaluated per session, not assumed from connectivity).
- Provider adapter interface: `generate(request: ResolvedPrompt, config: ModelConfig, schema?: JsonSchema) → ModelResult` with normalised errors (timeout, rate-limit, safety-block, malformed). Adapters: Anthropic, OpenAI, **DeterministicMock** (seeded, schema-aware — the test workhorse).
- Every call writes a `model_calls` provenance row (full field list in the data model doc) before and after execution; raw output stored immutably; parsed/validated output stored separately; reprocessing creates new rows, never overwrites.
- Structured outputs validated against the protocol's frozen `model-output.schema` before anything is shown to a participant or saved as derived data; validation failure triggers the protocol's declared fallback (skip stage / predefined text / queue for later) — the participant's narrative is already saved regardless.
- Minimisation: prompts are built only from protocol-declared variables; direct identifiers are structurally unavailable to the prompt resolver (identity service is a separate schema — see below); provider data-retention/training flags recorded per model config; regional endpoint pinning supported.

## 7. Identity separation & security architecture

- **Two Postgres schemas with separate DB roles:** `identity` (participant registry: names *if a study truly requires them*, DoB, contact, linkage table) and `research` (everything else, keyed by pseudonymous `participant_code`). The API's research role **cannot read** `identity`; a narrow linkage service (own role, own audit log) resolves codes for authorised operations (e.g. longitudinal matching, withdrawal execution).
- Exports omit identifiers by default; identifier export requires an explicitly-privileged role + per-export justification recorded in the audit log.
- Encryption in transit: TLS 1.2+ everywhere incl. device sync. At rest: Postgres disk encryption + application-level encryption for `identity` columns.
- Audit log: append-only, covers auth events, draft edits, publishes, exports, permission changes, deletions, safeguarding-flag access.
- Environment separation: dev/test/prod isolated; **prod data never used in development** — a seeded synthetic-participant generator ships with the repo; test fixtures are synthetic by construction.
- Consent withdrawal & deletion: withdrawal marks sessions; deletion workflow removes/crypto-shreds response events and narrative records per study policy, writes a tombstone (IDs + hashes only) so dataset reproducibility failures are explainable; device-loss runbook = revoke enrolment cert + escrowed-DEK destruction renders local ciphertext unreadable.
- Researcher-account removal, study closure, archiving: role-driven runbooks; closed studies become read-only with releases + manifests retained.

*(Architectural guidance, not legal advice: UK GDPR/ethics/IG sign-off sits with the university DPO and ethics committee.)*

## 8. Validation & testing strategy

- **Publish gate (hard failures):** unreachable items, circular/contradictory logic, duplicate variable names/IDs, unresolved prompt variables, missing narrative fallback, licence-blocked instruments, missing offline declaration, scale/version incompatibilities, missing consent screens.
- **Engine tests:** property-based tests over the logic AST; golden-path simulations of every release (the engine runs headless in Node) — the **YBM release is a permanent regression fixture**: fixed synthetic participants replayed through the engine must produce byte-identical canonical exports across platform versions.
- **Scoring tests:** canonical worked examples per instrument (e.g. published SDQ/RCADS scoring examples) + crosswalk round-trip tests (legacy codes → canonical → legacy is identity).
- **Offline/sync tests:** Playwright (Chromium) for service-worker/IndexedDB flows + fault-injection (kill mid-write, replay batches, clock jumps, duplicate submissions); physical-iPad manual acceptance protocol (separate doc §10 checklist mirrored from the brief) — desktop emulation is explicitly not accepted as proof.
- **Narrative tests:** full matrix from the brief (template resolution, missing variables, malformed/unsafe outputs, timeouts, rate limits, retries, idempotency, queued offline processing, correction flows, provider substitution, reprocess-without-overwrite, withdrawal).
- **Accessibility tests:** axe-core CI on every screen type + manual screen-reader script (VoiceOver on iPad in the device protocol).
