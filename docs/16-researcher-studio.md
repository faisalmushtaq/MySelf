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
- **`ci.yml`** runs on pull requests and on `main` (not on every push to a working branch, to save Actions minutes):
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
| R2 | **Offline-first participant app.** iPads can be offline for days, sittings resume on the same device, and a sitting must never straddle two versions. | Each sitting is pinned to the release it started under. Manifests are cached in IndexedDB. The app switches release only at the start screen. The last known-good release (r8.0.0) stays bundled as the offline fallback, and a device never waits on the network (§5.3). |
| R3 | **Licensed, validated instruments.** The gate checks licence status but nothing enforces `modifiable: "no"`. A Studio that lets anyone reword the SDQ would break licence terms and psychometric validity. | Validated instruments are **locked** in the Studio: wording, options, codes, order and type cannot be changed. They can be moved, shown conditionally and made required or optional. The server refuses a draft whose locked content differs from the library (§4.4). |
| R4 | **Ethics-approved wording.** The consent and intro text is approved under PSCETHS-1449 (D-24, D-40). | The consent module is **protected**. Editing it needs an explicit unlock that records an ethics acknowledgement in the audit log (§4.4). |
| R5 | **Identity separation and participant linkage.** Ingest links sittings on four secret-code `ybm_identity` items (to r7.3.0) or on first name, last name and date of birth (from r8.0.0, D-52), and diverts `identifying` answers (D-37). Changing those items would break linkage or leak PII into the dataset. | The identity items are protected. Validation blocks removing them or changing their type, key or variable, and warns on any other change. Free-text questions carry a sensitivity warning. |
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
  components were out of Studio scope at first; §10 (2026-10-02) brings
  MyStory into the Studio as a survey-level setting.

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
| **Protected** | the consent module (`ybm_intro_consent`) and linkage/identity items (`ybm_identity`) | anything, after an explicit unlock that records an ethics or linkage acknowledgement in the audit log | identity items' key, type or variable; the questions sittings are linked on cannot be removed — the four participant-code components to r7.3.0, first name, last name and date of birth from r8.0.0 (D-52) |
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

**Version numbers** continue the existing release series (r8.0.0 → r9.0.0 …).
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
   the bundled r8.0.0. A device never waits on the network, and a bad or
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

A restore keeps the current draft's **scoring rules** for every questionnaire
both have. Scoring is corrected in the library, not in the Studio (r7.2.0
fixed SWEMWBS and STAI-5), so restoring older wording never brings back
scoring that was put right. The emergency rollback has no such protection: it
makes the old release live exactly as published, scoring included. Making
r7.1.0 or earlier live again would field the SWEMWBS and STAI-5 scoring that
r7.2.0 fixed.

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
  - writes r5.0.0 through r8.0.0 from the functions bundle into
    `publicReleases` and `versions` (marked `source: "repository"`);
  - points `published/ybm_nd2026_standard` at r8.0.0, the release already live;
  - creates the draft from r8.0.0.

  It is idempotent and touches only the new collections.
- The first participant build that loads releases at runtime bundles r8.0.0 as
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

- **MyStory anywhere but last.** MyStory is one setting for the whole survey
  and always comes last (§10). It can't be placed mid-survey or more than once.
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

This section is for whoever runs, extends or audits MySelf Studio. §1–§8 give
the reasoning. This section says what exists and how to operate it.

### 9.1 What was built, and where

```
Researcher (Google account on the Studio list)
   │  https://faisalmushtaq.github.io/MySelf/researcher/#/surveys
   ▼
apps/researcher/src/studio/          the Studio (React, hash routes)
   ├─ data/          Firebase: sign-in, live queries, the auto-save engine, callables
   ├─ editor/        outline · question/section/screen editors · settings panel ·
   │                 validation panel · publish dialog
   ├─ preview/       preview.html: the participant's own screens, in memory
   └─ screens/       sign-in, not-authorised, surveys, versions, settings/access
          │ draft saves (Firestore rules: revision+1)     │ callables (trusted)
          ▼                                               ▼
Firestore studies/{study}/…  ◄──────────────  apps/functions/src/studio/
   surveys · draft · versions · published ·      access · publish · versions ·
   publicReleases · studioMembers ·              members · stats · draft-trigger
   studioAccess · studioAudit
          │ public get (REST, no SDK)
          ▼
apps/participant (MySelf Go, https://faisalmushtaq.github.io/MySelf/)
   lib/releases.ts   fetch pointer → fetch release → verify hash, schema and
                     engine → cache (IndexedDB v5) → pin each sitting to its release
```

The pure model is `packages/studio`, shared by the browser and the functions:
- `draft` and `walk`: extract a draft from a release, compile it back, and walk a
  draft in order;
- `ops`: every editing operation;
- `validate` and `locked`: validation, the licence locks and protected modules;
- `diff`: the change summary and version rules;
- `history`: IDs, variables and MyStory protocols reserved by earlier versions;
- `mystory`: whether MyStory is on, where it is, and reading and checking a
  protocol file (§10.1).

`packages/release/src/gate.ts` is the publish gate, split from hashing so a browser
can run it. `packages/schema/src/canonical.ts` is the one hash implementation.

### 9.2 Collections and documents

All are under `studies/{study}/` (the study is `ybm`). The typed shapes are in
`packages/studio/src/contract.ts`, and the paths in
`packages/firebase/src/layout.ts`.

| Collection | Document shape | Who writes |
|---|---|---|
| `surveys/{surveyId}` | `SurveyDoc` | functions |
| `surveys/{surveyId}/draft/current` | `DraftDoc` (the draft as a JSON string, `revision`) | editors, with a revision check |
| `surveys/{surveyId}/versions/{version}` | `VersionDoc` (immutable) | functions |
| `surveys/{surveyId}/presence/{uid}` | `PresenceDoc` | the person themselves |
| `published/{surveyId}` | `PublishedPointerDoc` (**public get**) | functions |
| `publicReleases/{hashHex}` | `PublicReleaseDoc`: the manifest as its exact JSON (**public get**, immutable) | functions |
| `studioMembers/{email}` | `MemberDoc` (the allowlist) | functions, or the CLI |
| `studioAccess/config` | `AccessConfigDoc` (domain rules) | functions, or the CLI |
| `studioAudit/{id}` | `AuditDoc` | functions only |

Existing collections, including `sessions`, are unchanged. **No response data was
migrated or rewritten.**

### 9.3 Roles and access

**Sign-in.** Firebase Authentication with Google (popup). The session is scoped to
the browser tab.

**Roles** (each includes the ones below it):

| Role | Can |
|---|---|
| viewer | read everything in the Studio, and preview |
| editor | viewer, plus edit the draft |
| publisher | editor, plus publish, restore a version into the draft, and make an earlier version live |
| admin | publisher, plus manage who has access |

**Where a role comes from:**
- The allowlist entry `studioMembers/{lower-cased email}` for a verified Google
  account.
- Otherwise a domain rule in `studioAccess/config`. An individual entry always
  decides over a domain rule.
- An existing `owner` custom claim counts as admin.
- Existing `researcher` or `analyst` claims do **not** give Studio access.

**Enforcement.**
- **Firestore rules** (`infra/firebase/firestore.rules`, Studio section) read
  the allowlist on every request.
- **Every callable** re-reads it (`apps/functions/src/studio/access.ts`, which
  resolves roles exactly as the rules do).
- Removing someone takes effect on their next request.
- No client can write the allowlist, the audit log, versions, releases or the
  pointer.

**Adding and removing researchers:**
- **In the Studio (admin):** account menu → *Who has access*, or a survey's
  *Settings → Access*. Add an email with a role, change a role, remove someone,
  and add or remove a domain rule. Public mail domains such as gmail.com are
  refused as domain rules. You cannot change your own entry. Every change is
  audited.
- **From a terminal**, with credentials for the project (needed for the very first
  admin):

  ```
  pnpm --filter @myself/functions studio-access add brainpopresearch@gmail.com admin --project myself-research
  pnpm --filter @myself/functions studio-access remove someone@example.org --project myself-research
  pnpm --filter @myself/functions studio-access list --project myself-research
  pnpm --filter @myself/functions studio-access domain brainpop.com editor --project myself-research
  ```

  Add `--key-file sa.json` to use a downloaded service-account key instead of
  `gcloud auth application-default login`. Delete that key afterwards.

### 9.4 Security rules and their tests

`infra/firebase/test/studio.rules.test.ts` (47 tests), with the existing
`rules.test.ts` (20), runs against the Firestore emulator:
- **Authorised:** each role, a domain member, the owner claim.
- **Unauthorised:** signed out; not listed; an unverified email; a non-Google
  provider; anonymous; a device; researcher/analyst claims.
- **Malicious:**
  - wrong revision;
  - forged `updatedBy`, or a client timestamp;
  - an oversized draft;
  - creating or deleting a draft;
  - every write to versions, releases, the pointer, the list and the audit log;
  - listing the public collections;
  - domain spoofs (`evil@brainpop.test@attacker.com`, `…brainpop.test.attacker.com`);
  - a role in one study used in another;
  - collection-group queries.

The deploy workflow runs the rules suite before it deploys the rules.

### 9.5 Editing, validation and publishing

**Editing.**
- Every change is one of `packages/studio/src/ops.ts`'s operations, applied as
  one undo step.
- Saving is automatic, about 1.2 s after the last change. It is a Firestore
  transaction that succeeds only against the revision the editor loaded.
- If someone else saved first, the editor becomes read-only. It shows both
  versions and the editor chooses which to keep; nothing is overwritten
  silently.
- Offline, changes stay in the tab and save when the connection returns. Unsaved
  work also survives a crash in session storage.

**MyStory** (the outline's "MyStory" item, between the last section and the
completion screen; §10.1):
- a switch puts MyStory at the end of the survey or takes it out;
- "Start from" offers the survey's own protocol and the built-in ones;
- the protocol is shown as its TOML file, editable, and checked on every
  keystroke. Each problem is said in words. A `key@version` that already
  names other content offers the next free version;
- "Use this protocol" freezes it into the draft, as one undo step. The file
  can also be opened from, and saved to, disk;
- the title MyStory shows in the progress bar can be changed.

**Validation** (`validateDraft`) runs as you type, with the same context the
server uses. It checks:
- text is present;
- IDs and variables are unique and not reused from earlier versions;
- options, limits and patterns are valid;
- conditions point only at earlier questions and at options that exist;
- sections are not empty;
- the start and completion screens are configured;
- licensed content is unchanged;
- protected modules are unlocked before they change;
- linkage and identity items are intact;
- MyStory is last, alone in its section, and once; its protocol is carried
  whole, reads, passes its own checks, is approved, and does not reuse a
  `key@version` already published or built in with other content;
- every publish-gate failure is reported.

Errors block publishing and warnings don't. **Go to** jumps to the field.

**Preview** (the Preview tab):
- It runs the current draft on the participant app's own screen components, at
  desktop, tablet or phone size.
- You can restart, start from any question, see why each question is shown or
  hidden, and view the completion and review screens.
- Where MyStory would start is shown, with its protocol's `key@version`. It
  is never run: nothing is sent to a model.
- It uses an in-memory store behind a Content-Security-Policy that blocks the
  network. A build check fails if the preview can reach the participant app's
  storage or upload code.

**Publishing** (publisher and above), in the dialog:
1. Save.
2. Checks (acknowledge any warnings).
3. What changes, and which are breaking.
4. The version number. The minimum bump follows docs/06 §3, and you may choose a
   larger one.
5. A release note (required).
6. Confirm.

`studioPublish` then re-runs everything on the server and writes all of the
following in **one transaction**:
- the immutable release;
- the version record;
- the public pointer, with its generation incremented;
- the survey summary;
- the audit row.

The dialog says a version is live only after reading the public pointer back.

### 9.6 Versions, rollback and history

The **Versions** tab lists every version, newest first, with:
- status, version number, dates, authors and publisher;
- the release note and change summary;
- the number of sittings recorded under it.

From there you can:
- **Compare** any two versions, or a version with the draft.
- **Restore into draft.** The version becomes the draft. Questions it lacks are
  archived, not lost. Option values stay retired.
- **Make live again.** This is the emergency rollback. It repoints the live
  survey to an earlier published release, needs a reason, and is audited.
- **Download** a version's manifest.
- **Download provenance** (top of the page), as CSV or JSON: every version
  with its authors, publisher, based-on and restored-from versions, release
  note, change summary, bumps, MyStory protocol, sitting counts and the
  periods it was live (§10.2).

The **Activity** tab shows the audit trail. Draft edits are grouped per editor
per 10 minutes.

### 9.7 How the participant app picks up a version

At the start screen, in the background and never blocking:
1. It fetches `published/{surveyId}` over the Firestore REST API.
2. If the release named there is new, it fetches `publicReleases/{hash}`.
3. It checks the release's canonical SHA-256, parses every question with the
   schema and checks the engine version.
4. It caches the release, then switches to it at the start screen.

**Fallbacks:** offline, or on any failure, it uses the last release it verified,
or the built-in r8.0.0.

**Files a release pins:** from r8.0.0 a release can pin a file by path, SHA-256
and size (the West Yorkshire postcode list the address question checks against,
D-52). The app carries those files in its build. It refuses a downloaded release
that pins a file it does not carry, or one whose hash differs, so a postcode
check is never silently switched off or run against the wrong list. The Studio
cannot change pins: a draft keeps the pins of the release it came from, and
`studioPublish` refuses a pin no published version has (`asset.unknown`). A new
list is a new file in a code release first.

**Pinning:** each sitting stays on the release it started with, including when it
is resumed after a newer publish. The footer's staff line shows the release in
use and whether it is built in or downloaded.

**One-time rollout note (add to the fielding runbook):**
- iPads running today's build pick up this build only after MySelf is fully
  closed and reopened.
- The new service-worker handling never reloads mid-sitting, so the old page is
  never told to take over.
- From this build on, a new *survey version* needs no app update at all.

### 9.8 Deployment (first time)

1. **Merge to `main`.** `firebase.yml` then:
   - runs the rules tests;
   - deploys the rules and indexes (including the new `studioAudit` index);
   - deploys the functions (the path filter includes `packages/studio`,
     `release`, `library`, `engine` and `scoring`), including the 10 new Studio
     functions;
   - deploys hosting.

   `pages.yml` deploys the participant app (with runtime loading) and the Studio.

   Until step 4, the participant app finds nothing published and keeps running
   the built-in r8.0.0, exactly as today.
2. **Firebase console → Authentication:**
   - Google is enabled as a sign-in provider (the researcher view already uses
     it);
   - `faisalmushtaq.github.io` is in *Authorised domains*.
3. **Give BrainPOP Research access:**
   - either the existing owner signs in at `/MySelf/researcher/#/surveys` and
     adds `brainpopresearch@gmail.com` (for example as admin) under *Who has
     access*;
   - or run the `studio-access add` command above.
4. **An admin opens the Studio and presses "Set up from the live survey".** This:
   - imports r5.0.0 to r8.0.0 as version history, marked as from the
     repository;
   - points the live pointer at r8.0.0;
   - creates the draft.

   It is idempotent.
5. **Smoke test:**
   - the participant link's staff footer should still show release 8.0.0;
   - make a harmless edit, preview, and publish a MINOR version (for example a
     study label);
   - the participant start screen shows it on its next load;
   - roll it back with *Make live again* on r8.0.0.

The emulator end-to-end test (`pnpm test:e2e:studio`, and the `studio` CI job)
performs this whole loop.

### 9.9 Rollback

| What went wrong | Do this |
|---|---|
| A published version | Versions → *Make live again* on the previous one. It is atomic and audited. Devices switch at their next start screen. |
| A draft | Versions → *Restore into draft*, or undo. |
| The functions | Redeploy the previous commit's functions. Data in Firestore is unaffected. |
| The participant build | Revert its commit on `main`. The previous build runs its built-in release. Version 5 of the device database only adds tables, so older builds still open it. |
| The rules | Redeploy the previous `firestore.rules`. The Studio collections are additive. |

**Nothing in any rollback touches a sitting.**

### 9.10 Tests

| Command | What it covers |
|---|---|
| `pnpm -r test` | Unit tests. The Studio model alone has 302, including the exact round trip of r7.1.0 through the Studio and of a version with MyStory. |
| `pnpm --filter @myself/functions test:integration` | Publish atomicity, conflicts, concurrent publishes, idempotent retries, rollback, restore, access races, and publishing with MyStory (Firestore emulator). |
| `cd infra/firebase/test && npm test` | The rules (67 tests). |
| `pnpm test:e2e` | The participant app, including runtime loading, pinning, a tampered release and the database upgrade (15 tests). |
| `pnpm test:e2e:studio` | The whole Studio loop (§9.8) on the Auth, Firestore and Functions emulators, and a second loop that switches MyStory on, publishes it and downloads the provenance. |

### 9.11 Decisions for the research team to confirm

1. **Who is admin or publisher.** For example, `brainpopresearch@gmail.com` as
   admin, or a `brainpop.com` domain rule if it is a managed Google Workspace.
2. **Licensed instruments are locked.** Wording, options, codes and order can't
   change. The consent and identity modules need an audited unlock.
3. **Minimum version bump.** A publisher may choose a larger bump but never a
   smaller one than the changes need. Any question wording change is MAJOR.
4. **Existing claims.** Researcher and analyst claims holders do not get Studio
   access automatically.
5. **Release manifests now live in Firestore, not git.** They are still
   immutable and content-hashed. This supersedes part of D-43's "in version
   control" reasoning for survey releases.
   - They are downloadable from Versions.
   - Committing them periodically to `releases/` keeps git as a second record.
6. **MyStory (§10).**
   - A protocol is fielded only once its file says `approval_status =
     "approved"`. The Studio trusts whoever sets that: it records who
     published, not who approved. Every built-in protocol ships as `draft`.
   - An edited protocol must take a new version; a `key@version` is never
     reused for different content.
   - Switching MyStory on or off, or changing its protocol, is a MAJOR version.
   - The relay runs exactly the model settings the sitting's release froze.

### 9.12 Known limitations

- **Hidden settings.** The following aren't supported by the participant app, so
  the Studio doesn't offer them:
  - MyStory anywhere but at the end, or more than once;
  - a Likert grid on one screen;
  - minimum selections or characters;
  - media;
  - randomisation;
  - section transition text.
- **No test-session collection.** The preview is in memory only.
- **Shared origin.** The Studio runs on the shared `faisalmushtaq.github.io`
  origin. Moving it to Firebase Hosting would give it its own.
- **Exports.**
  - BIDS sidecars still come from one release.
  - The researcher view's BIDS download still uses its compiled-in latest
    release.
  - Sittings under an unknown release are listed in `unreadable.json` by the
    nightly export and are no longer misread.
- **Publish cost.** Each publish and restore reads every stored release of the
  survey (about 130 kB each). This is fine at the current scale.
- **Domain rules.** A domain rule can't tell a Workspace-managed account from a
  personal Google account registered with a work address, because Firebase ID
  tokens carry no `hd` claim.
- **Diff wording.** A question restored from the archive shows as "added" when
  compared with a published version. Both are MAJOR, so this affects only the
  wording.
- **WebKit** runs in CI only.
- **MyStory in the preview.** The preview shows where MyStory starts but never
  runs it. Try a protocol in the MyStory lab, or on a test device against a
  published version.
- **Two protocols can't be edited as files.** `np.micro_narrative` and
  `np.future_self` have stages the TOML format can't express. They can be
  chosen, but only as they are.
- **Provenance.** Live periods come from the audit trail, so periods before
  the Studio existed are not listed. Each download reads the survey's whole
  audit trail, edits included, because the trail has no other index; this is
  fine at the current scale.

---

## 10. MyStory and version provenance (built 2026-10-02)

The research team asked for two more things. In their words: MyStory should
be "added on or not to the survey (sometimes we want it on and other times
not) and which Toml (and ability to edit that TOML etc). The MyStory would
always come afterwards — just that the hand back to researcher would be
completed AFTER that completion part." And: "We want provenance of survey
versions to be able to easily extract."

This section was written as the design before the change was built, and
then kept to what was built (§10.3 says where). It supersedes the part of
D-43 that kept narrative components out of the Studio (§3, §8). The protocol
editor in the researcher view still saves to a file.

### 10.1 MyStory in a draft and in a release

**One setting for the whole survey: on or off.**
- On means the survey's **last** section is `mystory` ("MyStory"), holding
  exactly one component: `{ kind: "narrative", protocol, protocolVersion }`.
- So a participant meets the survey, then MyStory, then the finish screen,
  then the hand-back to the researcher. The participant app already words
  MyStory's way out as the end of the survey when it is last (2af8462).
- Off means there is no such section.

**The protocol is frozen, not referred to.**
- The draft carries the protocol's full definition, by `key@version`, in a
  new optional field, `draft.narrativeProtocols`.
- Publishing freezes it into the release as releases always could:
  `narrativeProtocols`, the assembled `prompts` and the `modelConfigs`.
- The survey sends the module exactly that protocol (2af8462). A version
  published from the Studio can therefore carry a protocol edited there.
- `extractDraft` reads it back out of a release, so restoring or comparing a
  version with MyStory keeps it.

**Choosing and editing it** (the editor's "MyStory" item, between the last
section and the completion screen):
- Switch it on or off.
- Start from a built-in protocol (`@myself/narrative`) or the one the draft
  already has.
- See and edit it as TOML: the same file the MyStory lab and the protocol
  editor read and write (docs/08 §10.6).
- It is checked on every keystroke with the protocol schema, `checkProtocol`
  and the approval rule, and each problem is said in words. A protocol not
  yet approved can be used in the draft and previewed; publishing refuses it.
- "Use this protocol" freezes it into the draft, as one undo step. The file
  can be opened from, and saved to, disk.
- The title MyStory shows in the progress bar can be changed.
- `np.micro_narrative` and `np.future_self` have stages the file format
  cannot express. They are offered as they are, not as TOML.

**A `key@version` names one protocol for good.**
- An edited protocol needs a new version.
- Validation refuses a `key@version` that a published version of this survey,
  or a built-in protocol, has with different content. The editor offers the
  next patch number.
- Only an approved protocol can be published (the gate, unchanged). Every
  built-in protocol is `draft` today, so fielding one means setting
  `approval_status = "approved"` once it has been approved, and so a new
  version.

**Where it sits is enforced, not hoped for.**
- `setMyStory(draft, protocol | null)` is the one operation that switches it.
- Switching it on sets `offline.narrativeConnectivity` to `online_required`
  when that is unset. Switching it off removes the section, the protocol and
  that setting.
- Every operation that adds or moves a section, block or question keeps
  MyStory last. A new section goes in before it. A change that would put
  anything after it, or in it, is refused with a reason. Its section is
  removed only by switching MyStory off.
- Validation reports a draft where MyStory is not last, holds anything else,
  or appears twice. The server runs the same validation.

**Engine version.** A release with a narrative component needs engine
`0.4.0`: a participant build that sends the module the release's own
protocol. An older build refuses such a release and keeps running the one it
has, so it never runs a protocol bundled with the module in place of the
frozen one.

**Version number.** Switching MyStory on or off, or changing its protocol,
is participant-visible, so it is MAJOR. The change summary says so plainly:
"MyStory added (np.phone_wellbeing@0.1.1).", "MyStory removed (…)." or
"MyStory protocol changed from A to B." The connectivity setting that comes
with it is not listed separately.

**Preview.** The preview shows where MyStory would start. It never runs it:
nothing is sent to a model and nothing is saved.

**Model calls.** The relay admits a model config only from a release.
- The module now sends the sitting's release hash with each call.
- The relay resolves that hash the way every reader does (`resolveRelease`:
  bundled, else the release store with the hash re-verified).
- It runs exactly the config that release froze, whoever is calling. A
  release the study never published, or a config the release did not freeze,
  is refused.
- A release store that can't be read is a refusal the module may retry,
  never a fall-back to some other release's settings.
- A call with no hash (the MyStory lab on its own) is treated as before.
- A participant's iPad must send one (§10.4, D-55).

**What changes on the survey side.** The release format does not change.
There is a new engine version (`0.4.0`), the relay reads Studio-published
releases, and the module sends the release hash to the relay (the relay
adapter in `@myself/llm` carries it).

### 10.2 Version provenance export

**Where.** Versions → "Download provenance", as CSV or JSON.

**One row per version**, newest first:

| Column | From |
|---|---|
| version, release key, hash, engine version | the version record |
| status (live or previous) | the survey's live pointer |
| source (studio or repository) | the version record |
| authors, publisher, published at | the version record |
| based on, restored from | the version record; the last restore before it in the audit trail |
| release note, change summary | the version record |
| required bump, chosen bump | the change summary's bump; the bump the number took |
| MyStory (on or off) and its protocol `key@version` | the release itself |
| sittings complete and partial | `studioResponseStats` (counts only) |
| periods it was live | the audit trail: each publish, each "make live again", and the set-up from the live survey |

**Nothing new is stored.** It reads what the Studio already keeps: the version
records, their releases, the audit trail and the sitting counts. It is read in
the browser under the existing rules, which already let any Studio member read
all four. There is no new collection, function, rule or index: the survey's
whole audit trail is read page by page through the index the Activity tab
uses.

**The files.**
- CSV columns: `version`, `release_key`, `hash`, `engine_version`, `status`,
  `source`, `authors`, `publisher`, `published_at`, `based_on`,
  `restored_from`, `release_note`, `change_summary`, `required_bump`,
  `chosen_bump`, `mystory`, `mystory_protocol`, `sittings_complete`,
  `sittings_partial`, `live_periods`.
- Times are ISO 8601 (UTC). Authors are separated by `; `, change-summary
  lines by ` | `, and live periods by `; `, each written as "from to to
  (how)", with "now" for the one still live.
- A column left empty is one that could not be read (a release that would not
  load, sittings that could not be counted), never a guess.
- JSON: `{ format: "myself-studio-provenance", formatVersion: 1, study,
  surveyId, title, exportedAt, live, notes, versions }`, with the same rows
  and each live period as `{ from, to, how, by }`.

**Safe to open in a spreadsheet.** A cell that starts with `=`, `+`, `-`, `@`,
a tab or a carriage return is prefixed with `'`, so it is shown, not run.
Quoting follows RFC 4180, and the file is UTF-8 with a byte-order mark.

**No participant data.** Sittings are counts. The release note, change summary
and names are the research team's own.

**Live periods come from the audit trail.** A version published before the
Studio existed was live before the trail began, so its earlier periods are not
in it.

### 10.3 Where it is

| What | Where |
|---|---|
| MyStory in the model: placement, protocol files, `setMyStory`, validation, diff | `packages/studio/src/{mystory,ops,validate,diff,draft,history,model}.ts`, tests in `mystory.test.ts` |
| The gate: engine `0.4.0`, the protocol parsed before it is checked and frozen | `packages/release/src/gate.ts` |
| The editor's MyStory item and its checks | `apps/researcher/src/studio/editor/node/MyStoryEditor.tsx`, `mystory.ts` |
| The preview | `apps/researcher/src/studio/preview/runner.tsx` (`narrative.preview`) |
| Publishing with the published protocols | `apps/functions/src/studio/publish.ts` |
| The relay | `apps/functions/src/relay-policy.ts` (`configForCall`), `relay.ts`; `packages/llm/src/adapters/relay.ts`; `apps/mystory-lab/web/main.ts` |
| The participant app | `apps/participant/src/lib/narrative.ts`, `components/NarrativeStep.tsx`, `SurveyScreen.tsx`, `lib/releases.ts` |
| Provenance | `apps/researcher/src/studio/data/provenance.ts`, `screens/Versions.tsx` |
| A participant's iPad and its limits (§10.4) | `apps/functions/src/relay-policy.ts` (`DEVICE_LIMITS`, `deviceLimitReached`), `relay.ts` (`authenticate`, `meterDevice`), `narratives.ts`, `transcribe.ts`; `apps/mystory-lab/web/host-protocol.ts`; `apps/participant/src/lib/narrative.ts`; `.github/workflows/pages.yml`, `firebase.yml` |

### 10.4 MyStory on a participant's iPad (D-55)

A version with MyStory on runs it for participants, on the iPad, with nobody
signed in. The decision and its reasons are D-55 (docs/09 §5); the operating
side is the fielding runbook (docs/15 §10). In short:

- **Where the module is.** The Pages build tells the survey
  (`MYSELF_MYSTORY_URL` = `https://faisalmushtaq.github.io/MySelf/mystory`).
  Without it a MyStory position still says it is not available on this device
  and lets the participant past.
- **Who is calling.** The survey sends the module the iPad's own credential by
  `postMessage`, addressed to the module's origin, with the protocol. Never in
  the URL. The module takes it only from a host origin it trusts and keeps it in
  memory. It calls the relay, `transcribe` and `saveNarrative` with it, and
  does not ask anyone to sign in.
- **What it may run.** Only the config the sitting's release froze: a device's
  call without a release hash is refused.
- **How much.** 120 model calls per iPad per day and 2,000 across all iPads per
  day by default, a transcription counting as one call. A refusal says so in
  words for the participant, and the survey offers the way past at once.
- **Off.** Either limit set to `0`, with no code change.
- **The preview** never runs the module, as before (§10.1).
