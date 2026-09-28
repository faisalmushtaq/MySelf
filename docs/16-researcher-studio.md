# 16 — MySelf Studio: researcher survey builder

Status: design agreed for implementation, 2026-09-28. This document covers the
first three steps of the Studio brief: an audit of what exists, the risks it
raises, and the survey schema and versioning model the Studio is built on. The
technical handover (§9 onwards) is kept up to date as the implementation lands.

The one-line version: **the Studio edits a draft of the same release model the
survey already runs on, and publishing freezes that draft into an immutable,
content-hashed release exactly like the ones in `releases/`. The difference is
that the release is written to Firestore by a trusted Cloud Function instead of
to git by a person, and the participant app loads the active one at the start
screen instead of having it compiled in.**

---

## 1. What exists today (audited at `ee554ac`)

### 1.1 How a survey is defined and changed

| Piece | Where | Notes |
|---|---|---|
| Question library | `packages/library/src/{instruments,modules,scales}.ts` | Validated instruments (SDQ, RCADS, SWEMWBS, KSS, EHI, STAI, BIS/BAS, Doomscrolling, MacArthur) plus the study's own modules (`ybm_*`). |
| Composition | `packages/release/src/compose-ybm.ts` | Sections → components → instrument/module references, the start-screen code rule, the finish and review screens. |
| Publish gate + freeze | `packages/release/src/builder.ts` (`buildRelease`) | Resolves the composition against the library, refuses unsafe releases (licence, unresolved references, duplicate variables, branching on later questions, …), and freezes a manifest hashed with SHA-256 over canonical JSON. |
| Releases | `releases/ybm_nd2026_standard_r*.manifest.json` | Immutable. r7.1.0 is live (`sha256:308f47ba…5bee`). |
| Cutting a release | `node packages/release/publish.mjs <semver> <D-refs>` | Then three hard-coded imports are repointed and the change is merged, and a push to `main` rebuilds and redeploys everything. |

The survey structure in r7.1.0 is 9 sections, 18 components and 147 questions.
The components are 9 of the study's own modules (all `licence.modifiable: "yes"`)
and 9 validated instruments (`modifiable: "no"` or `"with_permission"`). There are
30 response scales and 6 scoring definitions.

### 1.2 How a response is identified (the data that must stay readable)

- A **sitting** is an append-only event log. It is one Firestore document,
  `studies/{study}/sessions/{sessionId}`, plus chunk documents when it is large.
  Only the `saveSitting` function writes it. The rules forbid editing a log or
  deleting a sitting.
- **Survey version** = `releaseHash`. It is stamped on the device row, on the
  `session.started` event, on the upload and on the stored document, and it is
  immutable per sitting: `conflictWith` quarantines a copy of a sitting that
  arrives under a different hash.
- **Question ID** = `itemKey` = `<instrument>.<item key>`, e.g. `kss.q1`.
- **Option value** = the integer `code` in the answer value (`{kind:"choice", code}`).
  Codes are resolved to labels through the release's scale at read time.
- **Analysis column** = the item's `variable`.
- Labels, wording, variables, scoring and the `identifying` flag all come from
  the manifest whose hash the sitting carries. Readers group sittings by hash
  and read each group through its own manifest (D-35).
- **Complete / partial**: `complete` on the sitting. A partial sitting is one
  uploaded as a checkpoint (`complete:false`). An abandoned sitting is a partial
  sitting with no later upload.

Nothing needs migrating. `releaseHash`, `itemKey`, `variable` and option `code`
already give every response a stable version, question ID and option value.

### 1.3 Firebase

- **Project.** `myself-research`, Firestore and Functions in europe-west2. 17
  Functions (v2).
- **Access control.** Firebase Auth custom claims: `role` is one of `owner`,
  `researcher` or `analyst`, granted by `grant-role.mjs` and the owner-only
  `setRole` callable. There is no email or domain allowlist today.
- **Rules.** `infra/firebase/firestore.rules` denies anything not named. It is
  tested against the emulator in `infra/firebase/test`.
- **Survey storage.** Nothing about surveys, drafts or releases is stored in
  Firestore. The functions know releases only as five manifests bundled at build
  time (`apps/functions/src/releases.ts`).

### 1.4 Apps and deployment

- **Participant app** (`apps/participant`, MySelf Go).
  - A React/Vite PWA on GitHub Pages at `/MySelf/`. It has no Firebase SDK.
  - The r7.1.0 manifest is compiled into the bundle (`App.tsx:4`).
  - Sittings are uploaded with plain `fetch` to `saveSitting` using a
    device-issued credential.
- **Researcher view** (`apps/researcher`).
  - A React/Vite single-page app at `/MySelf/researcher/`. Its data tools are
    local-first.
  - It uses Google popup sign-in and reads sittings directly from Firestore
    under the rules.
  - It has no router. The only editor is the MyStory protocol editor, which
    saves to a file.
- **`pages.yml`** builds everything and publishes one GitHub Pages artefact from
  `main`. The researcher view is copied under the participant's `dist`.
- **`firebase.yml`** deploys on pushes to `main`:
  - Hosting (MyStory lab only) on every push.
  - Rules when the rules files change.
  - Functions (`--force`) when function-related paths change.
- **`ci.yml`** runs on every branch:
  - build, typecheck and unit tests;
  - Playwright e2e against the participant app;
  - the Functions integration suite on the Firestore emulator;
  - the sync e2e on the emulator;
  - the rules suite.

---

## 2. Risks and constraints the Studio has to respect

Each risk below is paired with how the design handles it.

| # | Risk | Handling |
|---|---|---|
| R1 | **Readers only know bundled releases.** A release published at runtime would be read by the nightly export through `latestRelease` (silently wrong), skipped by identity capture, and read through the latest release (with a warning) by the researcher view. | Every reader resolves manifests by hash through one registry: bundled manifests first, then the Firestore release store, with the hash re-verified over the raw JSON. An unknown hash is reported loudly and never read through another release (§5.4). |
| R2 | **Offline-first participant app.** iPads can be offline for days, sittings resume on the same device, and a sitting must never straddle two versions. | Each sitting is pinned to the release it started under. Manifests are cached in IndexedDB. The app switches release only at the start screen. The last known-good release (r7.1.0) stays bundled as the offline fallback, and a device never waits on the network (§5.3). |
| R3 | **Licensed, validated instruments.** The gate checks licence status but nothing enforces `modifiable: "no"`. A Studio that lets anyone reword the SDQ would break licence terms and psychometric validity. | Validated instruments are **locked** in the Studio: wording, options, codes, order and type cannot be changed. They can be moved, shown conditionally and made required or optional. The server refuses a draft whose locked content differs from the library (§4.4). |
| R4 | **Ethics-approved wording.** The consent and intro text is approved under PSCETHS-1449 (D-24, D-40). | The consent module is **protected**. Editing it needs an explicit unlock that records an ethics acknowledgement in the audit log (§4.4). |
| R5 | **Identity separation and participant linkage.** Ingest derives the participant code from four `ybm_identity` items and diverts `identifying` answers (D-37). Changing those items would break linkage or leak PII into the dataset. | The identity items are protected. Validation blocks removing them or changing their type, key or variable, and warns on any other change. Free-text questions carry a sensitivity warning. |
| R6 | **Stable IDs.** `itemKey = instrument.key`. Moving a question into another instrument changes its ID. | A question never changes instrument. A component may now show an ordered **subset** of its instrument's questions, so the same instrument can appear in two sections and a question can move between sections with its ID unchanged (§4.2). Keys and variables are locked once published. A key or variable used by any published version is reserved forever. |
| R7 | **Draft data leaking into production.** The participant's IndexedDB and the Studio share the GitHub Pages origin. | The preview runs in an isolated frame with an in-memory answer store. It has no Dexie, no device credential and no upload path, so nothing from a preview can reach `saveSitting` (§5.6). |
| R8 | **The public read path is new.** Until now devices could read nothing. | The only public reads are `get` (not `list`) of two things: the active pointer, which holds the hash, version and publish time, and an immutable manifest by hash. The manifest is exactly what participants already download inside the JS bundle today. |
| R9 | **Forgeable audit.** Today the rules let any signed-in account create rows in `studies/{study}/audit`. | Studio audit goes to a separate collection, `studioAudit`, that no client can write. Every row is written by a function in the same transaction as the action it records. |
| R10 | **Concurrent editing.** | Each draft has a monotonically increasing `revision`. A save is a transaction that only succeeds against the revision the editor loaded, and the rules require `revision == previous + 1`. On a conflict the editor is shown both versions, and nothing is silently overwritten (§5.5). |
| R11 | **Mid-sitting reloads.** vite-plugin-pwa's `autoUpdate` adds an unconditional reload that bypasses the start-screen gate. | Publishing no longer triggers a code deploy, so publishes cannot cause these reloads. The registration is also switched so the gate in `updates.ts` governs every reload. |
| R12 | **Old manifests fail the current schema.** r1–r4 fail at `composition.screens.finish.body`, and zod strips unknown keys. | Nothing changes for them: the schema extensions below are optional fields with no defaults. The registry verifies hashes over the raw JSON, so an extension can never make a stored manifest fail verification. |

---

## 3. Documented decisions this design keeps

- **D-18, D-31, docs/06 §3.** A published release is immutable. Corrections mean
  a new release, and the old one stays readable forever.
- **D-35.** Sittings are read back through the release they were collected under,
  matched by content hash.
- **D-10.** Instruments with blocked or permission-required licences cannot be
  published.
- **D-25 and D-26.** A condition, cross-check or option limit may only depend on
  an earlier question.
- **D-39.** Rules are the access control, tested against the emulator. Nobody
  edits a raw log.
- **D-43.** The MyStory protocol editor still saves to a file. Narrative
  components are out of Studio scope for now (§8).

---

## 4. Survey schema

### 4.1 One model, two states

A **draft** is the exact input `buildRelease` consumes, held as one JSON document:

```ts
interface StudioDraft {
  format: "myself-studio-draft";
  formatVersion: 1;
  surveyId: string;                                 // = composition.key, e.g. "ybm_nd2026_standard"
  composition: AssessmentDraft;                     // sections, screens, code rule, effort…
  instruments: Record<RefKey, InstrumentOrModule>;  // only what the survey uses
  scales: Record<ScaleKey, ResponseScale>;
  scoring: Record<ScoringKey, ScoringDefinition>;
  archived: ArchivedQuestion[];                     // retired questions, restorable
  retiredCodes: Record<ScaleKey, RetiredCode[]>;    // option values that must never be reused
  unlocked: Record<InstrumentKey, Unlock>;          // protected modules opened for editing
  meta: { [itemKey]: { reportingCategory?; codingNotes? } } …
}
```

A **published version** is what `buildRelease(draft)` returns: the frozen,
hashed manifest the participant app already knows how to run.

`extractDraft(manifest)` goes the other way. Publishing the extracted r7.1.0 with
r7.1.0's own metadata reproduces r7.1.0's hash byte for byte. A test holds that
round trip.

### 4.2 Schema extensions

Both extensions are optional with no defaults, so every stored manifest parses
and hashes exactly as before:

1. **`sectionComponent.items?: string[]`** (instrument and module components):
   an ordered subset of the form's question keys.
   - Absent: the whole form, in form order, which is today's behaviour.
   - Present: exactly those questions, in that order.
   - This is what lets a question move between sections, lets an editable
     module's questions be reordered per placement, and keeps IDs stable.
   - The gate checks that every listed key exists and that no question is
     administered twice.
   - `flattenManifest` and the dependency audit follow the subset order.
   - A second placement of the same instrument gets its own instructions unit
     key (`__instructions_<instrument>_2`). The first keeps today's key.
2. **`item.reportingCategory?: string`**: a free label for reporting (e.g.
   "Screen use"). It does not change what participants see.

**Participant capability.** A manifest that uses (1) is stamped with
`engineVersion "0.2.0"`. The participant app declares the engine versions it can
render and refuses anything newer, falling back to the release it already has.

### 4.3 Questions

**Stable identity**

| Property | Behaviour |
|---|---|
| **ID** | `itemKey = <instrument>.<key>`. It is generated from the question text when the question is created, can be edited until first publish, and is locked after that. |
| **Reporting label** | `variable`, the analysis column name. Same lifecycle as the ID. It must be unique in the survey and never reuse a published variable for a different question. |
| **Option values** | Each option has an integer `code` that is separate from its label. New options take the next free code. A code removed after publishing goes into `retiredCodes` and cannot be reused. |

**Question types.** The Studio exposes a type only when the participant app
renders it, validates it, stores it and reports it:

| Studio type | Engine `responseType` | Notes |
|---|---|---|
| Short text | `text_short` | Maximum length, pattern and pattern hint. |
| Long text | `text_long` | Maximum length. |
| Single choice | `single_choice`, presentation `cards` / `compact` / `grid` / `spectrum` | |
| Dropdown | `single_choice`, presentation `dropdown` | |
| Yes / No | `single_choice` with a two-option Yes/No scale | Preset. |
| Rating scale | `single_choice`, presentation `spectrum` (labelled points) or `slider` (numeric range) | Preset. |
| Likert set | several single-choice questions sharing one scale, one per screen | |
| Multiple choice | `multi_choice` | Maximum selections. |
| Number | `numeric` | min/max, integer only, unit label. |
| Date | `date` | Age plausibility bounds. |
| Info block | `info` | Title text, lede, "more info". |
| Consent statements | `checkbox_set` | Existing type. |
| Ladder, form fields, rank into groups | existing types | Editable on existing questions. Not offered for new ones. |
| Section break | a section | Title, plus optional show-if logic. |

Features the renderer does not honour stay off the Studio UI rather than
appearing to work:
- a Likert *matrix* on one screen;
- `minSelections` and `minChars`;
- media;
- option-order randomisation;
- `randomiseComponents`;
- section transition text.

"Other (please specify)" is built from primitives the whole pipeline already
supports: an `Other` option (kind `other_specify`) plus a follow-up short-text
question shown only when that option is selected.

**Branching** is show/hide on earlier answers. That is what the engine
evaluates, and it is forward-only by construction:
- Question- and section-level conditions use the existing logic operators.
- "Skip to …" is expressed as hiding the questions in between.
- No loops are possible, because a condition may only refer to earlier
  questions.
- Every path reaches the completion screen as long as no required question on it
  is unanswerable, which validation checks.

### 4.4 Editability tiers

| Tier | Which | Can change | Cannot change |
|---|---|---|---|
| **Locked (licensed instrument)** | `licence.modifiable` is `no` or `with_permission` | position of the whole block, section, block condition, required / allow-decline, hint, presentation | wording, options, codes, question order within the block, type, keys, variables, scoring |
| **Protected** | the consent module (`ybm_intro_consent`) and linkage/identity items (`ybm_identity`) | anything, after an explicit unlock that records an ethics or linkage acknowledgement in the audit log | identity items' key, type or variable; the four participant-code components cannot be removed |
| **Editable** | study modules and new Studio questions | everything | IDs and variables after first publish |

New questions go into the survey's own module `<study>_studio`, placed by subset
into whichever section they belong to.

### 4.5 Draft data lives in the draft, not in the release

Archived questions, retired codes, unlock records and reporting notes are Studio
state. They never enter a manifest. The manifest contains exactly what a
participant can experience.

---

## 5. Versioning, publishing and delivery

### 5.1 Lifecycle

```
Editing draft ──validate──► Ready ──preview──► Publish (release note + version) ──► Published (active)
      ▲                                                                                  │
      └────────── restore any version into the draft (rollback = restore + publish) ◄────┘
```

**Status shown in the Studio:**
- *Draft — unsaved* / *Saving…* / *Draft saved* / *Save failed*
- *Draft has changes not yet published*
- *Draft matches the live version*
- *Validation: N errors, M warnings*
- *Live: r8.0.0 (published 28 Sep by …)*

**Version numbers** continue the existing release series (r7.1.0 → r8.0.0 …).
The Studio suggests the bump from the diff, following docs/06 §3:

| Bump | When |
|---|---|
| **MAJOR** | Any change to the question set, wording, options, codes, types, required status, conditions, validation, variables or identifying flags. |
| **MINOR** | Participant-visible text outside questions: start and completion screens, section titles. |
| **PATCH** | Metadata only. |

A publisher may choose a larger bump, never a smaller one. A version number
cannot be reused. The release key stays `<surveyId>_r<MAJOR_MINOR_PATCH>`.

### 5.2 Firestore layout

All paths are under `studies/{study}/`, next to the existing collections, which
are untouched.

| Path | Holds | Read | Write |
|---|---|---|---|
| `surveys/{surveyId}` | title, active pointer copy, latest version, counts | Studio members | functions only |
| `surveys/{surveyId}/draft/current` | `content` (StudioDraft JSON string), `revision`, `updatedAt`, `updatedBy`, `basedOn` | Studio members | editors, with a revision check (below) |
| `surveys/{surveyId}/versions/{version}` | release note, change summary, hash, author, publisher, `itemKeys`, `variables`, source | Studio members | functions only; immutable |
| `surveys/{surveyId}/presence/{uid}` | who else has the editor open | Studio members | own document only |
| `published/{surveyId}` | **public** active pointer: hash, version, releaseKey, generation, publishedAt | anyone, `get` only | functions only |
| `publicReleases/{hashHex}` | **public** immutable manifest (exact JSON string) and its hash | anyone, `get` only | functions only; create-once |
| `studioMembers/{email}` | allowlist: role, added by, when | admins; each member reads their own | functions only |
| `studioAccess/config` | optional domain rule, e.g. `{ "brainpop.com": "editor" }` | admins | functions only |
| `studioAudit/{id}` | audit trail | Studio members | functions only; never updated or deleted |

**Draft write rule (editors):**
- `revision == resource.revision + 1`;
- `updatedBy == request.auth.uid`;
- `updatedAt == request.time`;
- only `content`, `revision`, `updatedAt`, `updatedBy` and `updatedByEmail` may
  change;
- `content` is a string under 900 kB;
- the draft cannot be created or deleted by a client.

The manifest and the draft are stored as JSON strings for three reasons:
- a string round-trips the exact bytes, so the hash can be re-verified;
- it avoids Firestore's limits on map depth, arrays of arrays and index entries;
- the `content` and `manifest` fields are exempted from indexing.

### 5.3 Participant runtime

The participant app resolves which release to run as follows:

1. **At the start screen**, in the background, with a timeout:
   - `GET` the pointer `published/{surveyId}` through the Firestore REST API
     (plain `fetch`, no SDK, the same approach as `saveSitting`).
   - If the pointer's hash is new, `GET` `publicReleases/{hash}`.
   - Recompute the canonical SHA-256 with WebCrypto.
   - Fully validate the manifest, including every question.
   - Check its `engineVersion` against what this build can render.
   - Cache it in IndexedDB (Dexie v5, a new `releases` table; add-only).
2. **Offline, or on any failure**, run the last verified cached release, or else
   the bundled r7.1.0. A device never waits on the network, and a bad or
   incompatible release is never rendered.
3. **Each sitting is pinned to its release.**
   - Resume finds the in-progress sitting by code whatever the hash, then
     renders it with *that sitting's* cached manifest.
   - A new version takes effect only for sittings that start after it arrives.
4. The footer and handover panel show which release is running, and why.

### 5.4 Readers

`resolveRelease(hash)` resolves a manifest by hash in this order:
1. the bundled map;
2. `publicReleases/{hash}`, with the hash re-verified;
3. otherwise the hash is **unknown**.

The nightly export, identity capture and the researcher view all use it.

The `?? latestRelease` fallback in `export.ts` is removed. An unknown hash is now
reported, and its sittings are neither read through another release nor
silently dropped.

### 5.5 Publishing (trusted, atomic)

`studioPublish` is an `onCall` function in europe-west2.

1. **Authorisation.**
   - A verified Google account with the `publisher` or `admin` Studio role.
   - The allowlist is re-read on the server for every call, so a revoked user
     cannot publish on a still-valid token.
2. **Validation.**
   - Studio validation runs, then `buildRelease` and its publish gate, both on
     the server.
   - Any error refuses the publish and returns the problems, each with a
     location.
3. **One Firestore transaction.** In order:
   - check the draft revision equals the one the publisher reviewed;
   - check the version is new and not lower than the required bump;
   - create `publicReleases/{hash}` and `versions/{version}`;
   - increment the pointer's `generation` and repoint it;
   - update `surveys/{surveyId}`;
   - append the audit row.

   Either all of these land or none do.
4. **Retries are idempotent.** If the version already exists for the same draft
   revision, the stored result is returned.
5. **Confirming success.** The Studio reports success only after it has
   re-read the public pointer and seen the new hash.

**Emergency rollback.** `studioActivateVersion` repoints the live pointer to an
earlier, already-published hash. It needs a publisher, requires a reason and is
audited. The ordinary rollback is to restore that version into the draft and
publish it as a new version.

### 5.6 Preview

The preview is the participant app's own screen components:
- `SurveyScreen`, `ReviewScreen`, the controls and the flattening and pipe code;
- rendered from the current draft, compiled in the browser;
- inside an isolated frame at desktop, tablet (820×1180) or phone (390×844)
  size;
- with an in-memory answer store.

From the preview a researcher can:
- restart, or start at any question;
- see which questions a path hides and why;
- step through a required or validation failure;
- see the completion screen.

Nothing is written anywhere. A banner makes that explicit.

### 5.7 Access control

**Sign-in.** Firebase Authentication with Google, using a popup. Session
persistence lasts for the tab, not across browser restarts.

**Allowlist.** `studioMembers/{email}` sets a role per verified Google address:

| Role | Can |
|---|---|
| `viewer` | read surveys and drafts; preview |
| `editor` | viewer, plus edit drafts |
| `publisher` | editor, plus publish, restore and roll back |
| `admin` | publisher, plus manage who has access |

An existing `owner` claim is treated as `admin`, so the current owner can add
the BrainPOP account from the Settings page. An optional domain rule, e.g.
`brainpop.com` → `editor`, admits every verified account in a managed Workspace
domain.

**Enforcement.** The allowlist is enforced in two places:
- **Rules** look up the member document for the signed-in, verified Google
  email on every request.
- **Functions** re-read it for every privileged call.

Removing someone is effective on their next request, with no token-expiry
window. Roles live only in server-written documents, so no client can grant
itself access.

**Bootstrap.** Either the existing owner uses Settings, or someone runs
`pnpm --filter @myself/functions studio-access add <email> admin` with Admin SDK
credentials. No credential is in the repository.

**What an unauthorised person sees.** A plain "This Google account isn't on the
MySelf Studio list" page with a sign-out button, and nothing else. A direct
Firestore call from that account is refused by the rules.

### 5.8 Audit

`studioAudit` rows record:
- `survey.imported` and `survey.created`;
- `draft.edited` (coalesced into one row per editor per 10 minutes, listing the
  questions changed, by a trigger on the draft);
- `draft.restored`;
- `draft.unlocked`;
- `version.published`;
- `version.activated` (rollback);
- `access.member_set`, `access.member_removed` and `access.domain_set`.

Each row carries: `at` (server time), `actor` (uid), `actorEmail`, `surveyId`,
`subject` and `detail`.

---

## 6. Migration

- **No response data is migrated, moved, rewritten or deleted.** Sittings keep
  the hash they were collected under. All existing manifests stay readable
  through the bundled registry.
- **One-time set-up is an explicit admin action** in the Studio, "Set up from
  the live survey" (`studioImportLive`). It:
  - writes r5.0.0 through r7.1.0 from the functions bundle into
    `publicReleases` and `versions` (marked `source: "repository"`);
  - points `published/ybm_nd2026_standard` at r7.1.0, the release already live;
  - creates the draft from r7.1.0.

  It is idempotent and touches only the new collections.
- The first participant build that loads releases at runtime bundles r7.1.0 as
  its fallback. So on the day it ships, every device renders exactly what it
  renders today.

---

## 7. Rollback plan (operational)

| Situation | Action |
|---|---|
| A published version is wrong | **Versions → "Make live again"** on the previous version. The pointer changes atomically and devices pick it up at their next start screen. |
| A draft is wrong | **Versions → "Restore into draft"**, then publish. |
| The Studio functions misbehave | Redeploy the previous functions build. The pointer and releases in Firestore are unaffected. |
| The runtime-loading participant build misbehaves | Revert the participant commit on `main`. The previous build runs its bundled release as before. |
| The rules change misbehaves | Redeploy the previous `firestore.rules`. The new collections are additive. |

---

## 8. Out of scope for this version (known limitations)

- **Narrative (MyStory) components.** They can't be placed from the Studio
  (D-43). Existing compositions don't use them.
- **Features the renderer doesn't honour.**
  - Presentation: a matrix/grid on one screen, media, randomisation, and
    section transition text.
  - Validation rules: minimum selections and minimum characters.
  - Adding them means engine and renderer work first.
- **Test sessions in a separate collection.** Not built. The preview is purely
  in-memory, which is the stronger guarantee.
- **Where the Studio is hosted.** It runs on the GitHub Pages origin, which the
  participant app and any other Pages site of the same GitHub user share.
  Firebase Hosting would give it its own origin (D-46). Moving it there is a
  deploy-only change.

---

## 9. Handover

§9 onwards is written as the implementation lands: architecture, collections,
roles, rules, lifecycle, deployment, rollback, managing researchers, and
limitations.
