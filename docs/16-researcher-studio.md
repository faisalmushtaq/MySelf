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

All are under `studies/{study}/`: `ybm`, or any other study space (§11). The
typed shapes are in `packages/studio/src/contract.ts`, and the paths in
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

`infra/firebase/test/studio.rules.test.ts` (55 tests), with the existing
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
- **Study spaces (§11):** the registry from every side (public `get`, `list`
  only for the project's people, written by nobody), two study spaces whose
  Studios are closed to each other in both directions, no Studio member reading
  any sitting, and an iPad of one study refused a sitting in another.

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
| `pnpm --filter @myself/functions test:integration` | Publish atomicity, conflicts, concurrent publishes, idempotent retries, rollback, restore, access races, publishing with MyStory, and study spaces through the deployed handlers (Firestore emulator; 105 tests). |
| `cd infra/firebase/test && npm test` | The rules (75 tests). |
| `pnpm test:e2e` | The participant app, including runtime loading, pinning, a tampered release, the database upgrade and participant links (30 tests on Chromium). |
| `pnpm test:e2e:studio` | The whole Studio loop (§9.8) on the Auth, Firestore and Functions emulators; a second loop that switches MyStory on, publishes it and downloads the provenance; and a third in which an owner creates a study space, publishes a survey in it, and its participant link files a sitting there (§11). |

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

---

## 11. Participant links and study spaces (D-56, designed 2026-10-06)

The research team asked whether the Studio could make "live links to different
versions of the study", for a standalone study on participants' perspectives
of the future or for the stages of MyPhone MyBrain, and whether that needs a
Firebase project each. The decision (D-56, docs/09 §5) is no: **one live
participant link per Studio survey, and study spaces inside the one project,
each with its own access list and its own data.**

This section was written as the design before the change was built. The
companion dashboard is built from §11.6, so that part is a contract: a change
to a path or a field there is a change to the dashboard too.

### 11.1 Two words

- A **study** (a *study space* in the Studio) is everything under
  `studies/{study}/`: its surveys, Studio access list, devices, sittings,
  narratives, audit and exports. `ybm` is one; a standalone study is another.
- A **survey** is a Studio survey in one study: its draft, its versions and its
  live pointer, `published/{surveyId}`. A study can have several (the stages of
  MyPhone MyBrain are surveys in `ybm`).

### 11.2 The participant link

```
https://faisalmushtaq.github.io/MySelf/?study=<studyId>&survey=<surveyId>
```

- **Ids.** A study id is 2 to 40 characters, `^[a-z][a-z0-9_]{1,39}$`. A survey
  id is a Studio survey id, `^[a-z][a-z0-9_]{0,63}$`. Nothing is lower-cased,
  trimmed or decoded into shape: anything else is refused, so an id can never
  carry a `/`, `.`, `%`, `?` or `#` into a path.
- **`study` may be left out** and means the deployment's default study (`ybm`).
  `survey` is required whenever there is a link at all. A parameter given
  twice is refused as ambiguous. Other parameters are ignored.
- **No identifying data.** A link names a study and a survey and nothing about
  anybody. The participant code is typed on the iPad, as before.
- **The Studio builds the link** from the participant app's address (the
  researcher view is served from its `researcher/` folder) and always writes
  both parameters, the default survey included, so a link to the default survey
  can move an iPad back to it.
- **The bare URL gives no instruction.** An iPad keeps the survey it is on. An
  iPad that has never been given a link is on `ybm` / `ybm_nd2026_standard`,
  so every iPad and link in use today behaves exactly as it does now. (A
  Home-Screen app always opens at the bare URL, so "bare means the default"
  would undo every choice made on it.)
- **The QR code** is drawn in the browser by a small, well-known library, from
  the same link, with no service involved. It works offline.

### 11.3 How an iPad chooses its survey and keeps it

**What it remembers.** In the device database beside the release cache
(`release_state`, which is keyed by `id`):

| Row | Holds |
|---|---|
| `selection` | `{ study, surveyId, chosenAt, chosenBy: "link" \| "staff", previous, lastLink }`. Absent means the default. |
| `active` | The default survey's active release and last check, exactly as today. |
| `active:<study>/<surveyId>` | The same for any other survey. |

No table is added or re-keyed (the reason is in `db.ts`, version 4). Each
sitting row also records its `study` and `surveyId`; a row without them is the
default's, which is what every sitting before this change was.

**Reading a link, once.** At start-up the app reads `study` and `survey`:

1. Anything that does not match the patterns: a plain message ("This link
   isn't one MySelf can use"), and the iPad stays where it was.
2. The same as the survey the iPad is on, or the same as the last link it
   followed (`lastLink`): nothing to do. That is what makes the link "read
   once": a Home-Screen app saved from a link opens on it every time, and must
   not undo a change staff made since in the handover panel.
3. Otherwise the app checks, online, in this order: the study's registry
   document exists and is open (§11.4; the default study needs no document);
   `published/{surveyId}` exists in that study; the release it names downloads
   and verifies (hash, schema, engine version, and that it is this survey of
   this study). Then it caches the release, saves the selection, records the
   link as followed, and the start screen shows the survey.
4. A definite refusal (no such study, the study is closed, nothing published,
   a release that fails verification) is said plainly on the start screen, and
   the iPad stays on the survey it was on.
5. **Offline, or the study cannot be reached:** a survey other than the default
   has no built-in fallback, so the start screen says so in words ("This iPad
   has been given a link to … It has to be downloaded once, and this iPad is
   offline. Connect it to the internet."), and Start is not offered. The app
   tries again by itself when the network returns, and on every launch while
   the link is in the address. Nothing is half-adopted.

**Staff change it in the handover panel** (five taps on the build line, as
today; a participant never sees it). The panel says which study and survey the
iPad is on, and offers:

- paste a participant link, or type `study/survey`, then **Check**: the same
  online check as a link;
- then **Use this survey on this iPad**, with a confirmation that says what
  happens to unfinished sittings (below);
- **Back to the default survey**, which works offline because the default has
  its built-in release.

**A sitting finishes where it started.** A sitting is stamped with its release
(as before) and now with its study and survey. Typing a code resumes only an
unfinished sitting of the survey the iPad is on, so after a switch a returning
participant is never put back into another study's questionnaire. An
unfinished sitting of the previous survey stays on the iPad, keeps uploading
its checkpoints to its own study, and can be finished after switching back.
The confirmation says how many there are.

**Uploads carry the study.** A sitting is posted to `saveSitting` with
`study` beside it, one sitting per request as now, so sittings of two studies
waiting on one iPad each land in their own study whichever survey the iPad is
on when they are sent. A handover file records each sitting's study.

**A closed study** (§11.4), once the start screen has seen it, starts no new
sitting: Start resumes an unfinished one and otherwise says the study is
closed.

### 11.4 Study spaces: the registry and their lifecycle

**The registry is one document per study**, `studies/{studyId}`:

| Field | Type | Meaning |
|---|---|---|
| `study` | string | the id, again |
| `title` | string | a name for people, e.g. "Perspectives of the future" |
| `status` | `"open"` \| `"closed"` | whether it takes new devices, new sittings and model calls |
| `createdAt` | timestamp | server time |
| `createdBy` | string | the creator's uid (their address is in the audit trail, not here) |
| `updatedAt`, `updatedBy` | timestamp, string | the last change of title or status |
| `closedAt` | timestamp or null | when it was last closed |

- **Public by `get`**, so an iPad can tell a closed study from an open one
  before anybody types a code. That is why it holds nothing but the id, a
  title and dates: **a study's title is visible to anyone who knows its id.**
  `list` is for the project's people (owner, researcher and analyst claims),
  so the dashboard can find every study. Nobody writes it from a browser.
- **`ybm` is registered implicitly.** The deployment's default study
  (`MYSELF_STUDY`, `ybm`) counts as registered and open whether or not it has
  a document, so nothing has to be written for it. An owner may give it a
  document from the Studio (to set its title, or to close it); that is the
  only way one appears, it is idempotent, and it changes no existing document.
- **Who creates one.** Only a project owner (the `owner` claim), in the Studio:
  **New study space**, with an id and a title. The function refuses an id
  already registered, the default's id, and an id with data already under it
  (a leftover from a test, say), so a new study always starts empty. The
  creator is added to its access list as **admin**, and the creation is the
  first row of its audit trail.
- **Closing and reopening.** An owner can close a study and reopen it, with an
  audit row each time. Closed means: no new device can register, an iPad that
  sees it is closed starts no new sitting, and MyStory makes no model calls
  for its iPads. The Studio still works on it. **A sitting from an iPad the
  study already knows is always accepted**, open or closed, so nothing
  collected before the closure is refused. A study is never deleted.
- **What each study has of its own.** Its `studioMembers` list and domain rules
  (already per study), its surveys and their links, its devices (an iPad is
  registered separately in each study it files into, first writer wins in
  each), its sittings, quarantine, narratives, voice recordings, audit trails,
  model-call counts and exports.

### 11.5 Access and data separation

**Who may do what in a study space:**

| | project owner (claim) | Studio member of the study | Studio member of another study only | researcher / analyst claim |
|---|---|---|---|---|
| create a study space | ✓ | ✗ | ✗ | ✗ |
| close or reopen it | ✓ | ✗ | ✗ | ✗ |
| use its Studio (by role) | ✓ (admin) | ✓ | ✗ | ✗ |
| manage its access list | ✓ | admin | ✗ | ✗ |
| read its sittings and narratives | ✓ | ✗ | ✗ | ✓ |
| get its registry document, live pointers and releases | ✓ (anyone) | ✓ | ✓ | ✓ |

- **Enforced by the rules** for everything a browser reads: every Studio rule
  is `studioLevel(study)` of the path's own study, so a role in A is nothing in
  B. The rules tests hold this for every Studio collection.
- **Enforced by the functions** for everything else. Each request that carries
  a study (`saveSitting`, the relay, `transcribe`, `saveNarrative`, the
  identity and export callables, every Studio callable) has it checked against
  the pattern and the registry before anything else is read, and a Studio
  callable then reads **that** study's list for the caller. A request with no
  study means the default, as every request did until now.
- **The Studio's study switcher** lists the studies where the signed-in person
  has a role (`studioSession` works it out on the server); an owner sees all.
- **Reading sittings stays project-wide.** The `owner`, `researcher` and
  `analyst` claims read sittings in every study, as they read `ybm` today; that
  is the dashboard's access. A Studio role never reads a sitting, in any study
  (counts only, as before). A per-study reader is a decision for the team
  (§11.11).

### 11.6 What the dashboard reads (the data contract)

All in the `(default)` Firestore database of `myself-research`.

**Listing studies.** `collection("studies")` (role claims may list), plus
`ybm`, which is a study whether or not it has a document. Use each document's
`title` and `status` (§11.4); `ybm` with no document is open, and its title is
its live survey's `composition.title`.

**Listing a study's surveys.** `collection("studies/{study}/published")`
(role claims may now list it; it was get-only). One document per survey with a
live version:

| Field | Meaning |
|---|---|
| `surveyId`, `study` | the survey and its study |
| `hash` | the live release, `sha256:<hex>` |
| `version`, `releaseKey`, `engineVersion` | of the live release |
| `generation` | increases on every publish or rollback |
| `publishedAt` | timestamp |

A survey's title is its release's `composition.title`. The Studio's own
summary, `studies/{study}/surveys/{surveyId}`, is for Studio members; the
dashboard does not need it. A survey that never went live has no pointer and,
by construction, no sittings.

**Reading a release by hash.** Bundled releases (`releases/*.manifest.json` in
the repository) belong to `ybm`. Anything else is
`studies/{study}/publicReleases/{hex}` (`get`, public), where `{hex}` is the
hash without `sha256:`: the `manifest` field is the exact JSON, whose
canonical SHA-256 must equal the hash before it is used (the same check as
`readStoredRelease`). A release is looked up in **its sitting's own study**:
the functions no longer resolve a bundled `ybm` release for another study.

**Sittings.** `studies/{study}/sessions/{sessionId}`, plus
`…/chunks/{0000…}` when `chunkCount > 0`. Unchanged:

| Field | Meaning |
|---|---|
| `study` | always the study in the path |
| `sessionId`, `deviceId`, `studyCode` | as before |
| `releaseHash`, `releaseKey` | the release it was collected under |
| `startedAt`, `completedAt?`, `complete` | as before |
| `quarantined`, `provenance`, `eventCount`, `chunkCount`, `events`, `receivedAt` | as before |

- **Its study** is the path's (equal to `study`).
- **Its survey** is `release.assessment` of the release `releaseHash` names,
  resolved in that study. (`releaseKey` is `<surveyId>_r<M>_<m>_<p>`, which is
  a display fallback, never the source.)
- **Its version** is that release's `release.version`.

**Also per study:** `narratives/{sessionId}` (the run, with `releaseHash`),
`quarantine`, `corrections`, `assignments`, `devices`,
`audit_relayDevices/{day}` and `{day}_{installId}` (MyStory's counts), and in
Storage `studies/{study}/voice/{sessionId}/…`. The identity project mirrors
the study in its own paths (`studies/{study}/participants`, `claims`, …).

**Nightly exports** (Cloud Storage): `exports/{YYYY-MM-DD}/…` for `ybm`,
unchanged, and `exports/studies/{study}/{YYYY-MM-DD}/…` for every other study
that has sittings. `exportNow` takes an optional `study`.

### 11.7 Offline

- **The default survey** is unchanged: it never waits on the network and falls
  back to its built-in release.
- **Any other survey** needs one online load. After that it runs offline for
  as long as the iPad keeps its storage (on the Home Screen, indefinitely),
  picks up a new version at the start screen when it can, and re-checks its
  study's status at the same time.
- **A link opened offline** says so on the start screen and starts nothing
  until it has been checked.
- **Sittings, checkpoints and uploads** behave as before; each carries its
  study. A sitting refused because its study cannot be found stays on the iPad,
  like any refused upload.
- **On an iPad, Safari and the Home-Screen app keep separate storage.** A link
  opened in Safari sets Safari's copy; for the Home-Screen app, open the link
  and add *that page* to the Home Screen, or paste the link into the handover
  panel inside the app (the runbook says so).

### 11.8 Security

| Threat | Handling |
|---|---|
| **A forged or mistyped link** | Ids match a strict pattern before any request; the study's registry and live pointer are checked; the release is verified over its raw JSON against the pointer's hash and must be this survey of this study. A link can choose only among surveys published in registered, open studies, and it cannot point the app at another host: the address is the build's, and only the two checked ids come from the link. |
| **Filing into a study that does not exist** | `saveSitting` refuses (404) before anything is read or written; the iPad keeps the sitting. An iPad can only be set to a study it has checked exists. |
| **Filing into a closed study** | A new installation is refused, so a link that circulates after a study closes files nothing. An installation the study already knows is accepted, so nothing collected is lost (§11.4). |
| **A request naming another study** | The study in a request is checked against the registry, and then everything else is checked **in that study**: the device credential (first writer wins per study), the Studio list, the release, the counts. A role, a registration or a count in one study is nothing in another. |
| **MyStory's study** | The survey puts the study in the module's address beside the release hash, which the module only acts on with a credential it was given by message from a trusted origin (D-55). The relay, `transcribe` and `saveNarrative` validate it, register and verify the iPad in it, resolve the release in its store only, and count against its limits; a closed study refuses an iPad's model calls as "switched off". |
| **Device limits** | Per iPad, per study registration: 120 a day each. The ceiling is per study (2,000 a day each), so one study's circulating link cannot close MyStory in another. The cost is that the worst day is the ceiling times the number of open studies with MyStory live; only an owner can create a study, and the OpenAI budget limit is the last line (D-55). |
| **Learning what studies exist** | Nobody without a role claim can list the registry. Anyone can `get` a study whose id they know, which shows its title and status, so titles are written for the public. |
| **Studio member of A in B** | Rules and functions read B's list for anything in B (§11.5). |
| **Privacy** | Links carry no identifying data; nothing logs an answer; the selection on the iPad is two ids. |

### 11.9 Migration

None. No document is written, moved or rewritten by the change; `ybm` needs
no registry document; existing iPads (no `selection` row) run what they run
today; existing links (the bare URL) mean what they mean today; existing
sittings, narratives and counts stay where they are; the dashboard's current
reading of `studies/ybm/…` is unchanged. Rolling back is redeploying the
previous functions, rules and Pages build: the registry documents and the new
`release_state` rows are additive, and an older build ignores them (it then
runs the default survey, and files into `ybm`, which is what it always did).

### 11.10 Where it is

| What | Where |
|---|---|
| The link format, the id patterns, reading a link or typed `study/survey` | `packages/schema/src/link.ts` (`participantLink`, `readParticipantLink`, `readTypedChoice`, `STUDY_ID_PATTERN`) |
| The registry path; the registry and scoped-request types | `packages/firebase/src/layout.ts` (`paths.study`); `packages/studio/src/contract.ts` (`StudyDoc`, `StudySummary`, `StudyScoped`, `CALLABLES.createStudy` / `setStudy`) |
| A request's study, checked against the registry | `apps/functions/src/studies.ts` (`lookupStudy`, `studyForRequest`, `studyForCall`, `registeredStudies`) |
| Filing, registering, metering and resolving per study | `apps/functions/src/{sittings,relay,narratives,transcribe,releases,identity,admin,export}.ts` |
| Creating, closing and reopening study spaces; the Studio callables per study | `apps/functions/src/studio/{study-spaces,functions,stats,requests}.ts` |
| The rules | `infra/firebase/firestore.rules` (the registry document; `published` listable by the project's people) |
| The iPad's choice of survey | `apps/participant/src/lib/selection.ts`; `lib/releases.ts` (a service per survey, the registry check); `lib/db.ts` (`selection` and `active:<study>/<survey>` rows, a sitting's `study`/`surveyId`); `App.tsx`, `main.tsx`; `screens/StartScreen.tsx`, `screens/SurveyChoiceSection.tsx`, `screens/HandoverPanel.tsx`; `lib/sync.ts` (the upload's `study`) |
| MyStory's study | `apps/participant/src/lib/narrative.ts` (in the frame's address); `apps/mystory-lab/web/host-protocol.ts` (`hostStudy`), `main.ts`; `packages/llm/src/adapters/relay.ts` (`study`) |
| The Studio | `apps/researcher/src/studio/route.ts`, `router.tsx` (`#/study/<id>/…`, `currentStudy`, `useStudy`); `data/*` (every read, save and call in the address's study); `shell/StudySwitcher.tsx`; `screens/ParticipantLink.tsx`, `ui/qr.ts` |

**Tests.** `packages/schema/src/link.test.ts`; `apps/functions/src/studies.test.ts`
and additions to `participant-devices`, `releases`, `export` and
`studio/requests` tests; `apps/functions/integration/study-spaces.integration.test.ts`
(19, on the emulator, through the deployed handlers);
`infra/firebase/test/studio.rules.test.ts` ("the study registry", "two study
spaces"); `apps/participant/src/selection.test.ts`, `sync.test.ts`,
`narrative-step.test.ts`; `apps/mystory-lab/web/host-protocol.test.ts`;
`packages/llm/src/llm.test.ts`; `apps/researcher/src/studio/{route,ui/qr,shell/study-switcher,shell/common}.test.ts`;
`e2e/study-links.spec.ts` (6); `e2e-studio/study-space.spec.ts`.

### 11.11 Decisions for the research team to confirm

1. **No separate Firebase projects.** One project, study spaces inside it, one
   deploy. A separate project is still possible for a study that must not
   share IAM, an OpenAI key or a budget with the rest; nothing here prevents it.
2. **Who creates a study space: project owners only** (the `owner` claim). The
   creator becomes its first Studio admin and adds the rest of its team from
   its own "Who has access".
3. **Device limits per study.** 120 calls per iPad per day per study, and the
   2,000-call daily ceiling per study, so a link circulating in one study
   cannot stop MyStory in another. The worst day is the ceiling times the
   number of open studies with MyStory live; the OpenAI budget limit is the last
   line. The alternative, one ceiling across the project, is a small change.
4. **Closing keeps what was collected.** A closed study refuses new iPads, new
   sittings on an iPad that can see it is closed, and MyStory's calls; it
   still accepts sittings from an iPad it already knows. An iPad that
   collected in a study but never reached the network before it closed must
   hand its sittings over as a file (or the study is reopened for a day).
5. **Reading sittings stays project-wide.** The `researcher` and `analyst`
   claims read every study's sittings, as they read `ybm`'s today. A
   per-study reader (a claim naming studies, or reader lists per study) is the
   next step if a study's data must be closed to the rest of the team.
6. **A study's title is public to anyone who knows its id.** Its registry
   document is readable without signing in, so an iPad can say a study is
   closed; titles are written for the public.
7. **A survey is copied only within its study.** "A published version of
   another survey" offers the study's own surveys. Starting a study space's
   survey from `ybm`'s would mean copying a `ybm` release into the new study's
   store (its locks are checked against it); worth doing if the team asks.
8. **The bare survey URL keeps an iPad on what it is on.** A link to the
   default survey (which the Studio writes with both parameters) is how to send
   an iPad back to it; so is "Back to the default survey" in its handover panel.
9. **The researcher view's data tools stay on the default study.** The
   companion dashboard reads every study from §11.6.

## 12. The item library, and copying between studies (D-57, designed 2026-10-06)

The research team asked that surveys be copied "across for different
versions", and that researchers "pick and drop in different items from
different surveys — making this modular with library of items". They chose
(docs/09 D-57):

- a library holding **every question and block ever published, in every study
  space, the validated questionnaires, and modules researchers save** by name;
- a reused module that is later improved gives each survey using it **an
  update notice**, never an automatic change;
- a copied question **keeps its question ID and its variable name**, so the
  same question in two surveys exports to the same column and can be pooled.

This section was written as the design before the change was built. Nothing in
it changes what a participant's iPad runs, the release format, or the data
contract the dashboard reads (§11.6): a survey built from library pieces is
published, frozen and fielded exactly as any other.

### 12.1 Words

- A **piece** is what is copied: one or more questions from one block, a whole
  block, or a whole section (its blocks, in order, under its title). Inside
  the code a piece is a *fragment* (`StudioFragment`).
- A **block** is a placement of an instrument or module in a section (§4).
- A **saved module** is a piece a researcher has named and put in the library,
  with a description, tags and numbered versions.
- **Provenance** is the record, kept in the draft and in every version
  published from it, of where each copied question came from.

### 12.2 The library's three shelves

| Shelf | What is on it | Where it comes from |
|---|---|---|
| **Saved modules** | Pieces researchers have saved, by title, description and tags, each with its versions | `studioLibrary/{moduleId}` and `versions/{n}`, project-wide (§12.6) |
| **Validated questionnaires** | SDQ (11–17, 18+), RCADS-25, SWEMWBS, STAI-5, KSS, SQS, EHI-SF, BIS/BAS, Doomscrolling, MacArthur | The instrument library in the code (`packages/library`), frozen exactly as a release freezes it |
| **Published surveys** | Every published version of every survey in every study space; the live version first | The release store (`studies/{study}/publicReleases/{hash}`), each release verified against its hash before anything is taken from it |

One search box searches the open shelf: question wording, variable names,
block names, and a saved module's title, description and tags. Published
surveys show each survey's latest version by default, with its earlier
versions a choice away.

**What can be picked.**

- From an **editable block**: any of its questions, or the whole block.
- From a **validated questionnaire**: only the whole questionnaire, exactly as
  licensed. Picking single items from a validated scale breaks its scoring and
  usually its licence; the Studio already refuses to change one (§4.4).
- From the **consent and identity modules** (`ybm_intro_consent`,
  `ybm_identity`): the whole module, and only with the reason recorded, as for
  unlocking one (§4.4). Consent wording is approved for a study; using it
  elsewhere is an ethics decision somebody must own.
- **A whole section**: its blocks in order, as a new section with its title.
- **MyStory is not a piece.** It is switched on per survey (§10.1), and is
  always last.

### 12.3 Adding a piece to a draft

Adding is an ordinary draft edit (`insertFragment` in `packages/studio`), made
in the editor and saved like any other, so it can be undone, previewed and
validated before anything is published. The piece goes where it was asked
for: after a chosen question, at the end of a section, or as a new section
(always before MyStory, and never before the consent module).

The rules, in order:

1. **The question ID and the variable are kept.** A question copied from
   `ybm_studio.pets` with variable `pets` is `ybm_studio.pets` and `pets` in
   the new survey too, and keeps its revision number. Its block's instrument
   comes with it.
2. **Already there.** If the draft already has the same question (same ID and
   the same content), it is not added twice; the summary says so.
3. **Renamed only on a clash, and always said.** If the ID is taken by a
   different question — in the draft, in its archive, or in anything this
   survey has ever published — the copy gets a new ID (`pets_2`) and revision
   1. If the variable is taken, the copy gets a new variable. A renamed copy
   loses any legacy variable, which belonged to the original. The summary
   lists every rename, because a rename means the data will not line up.
4. **Into the same block where it can.** If the draft already has the block's
   instrument and it is editable, the copied questions join it. A validated
   questionnaire is only ever added whole, and a survey holds one version of
   it: adding SDQ 2.0 where SDQ 1.0 is used is refused with that reason.
5. **Answer options.** An option list the draft lacks is added. One it has
   with identical content is shared. One it has under the same key with
   different content is added under a new key and the copied questions point
   at that — except for a validated questionnaire, whose options must be the
   licensed ones, which is refused instead.
6. **Scoring** comes with a validated questionnaire. Scoring with the same key
   and different content is refused.
7. **Display conditions** are kept when every question they test is in the
   draft after the copy (a renamed question is followed to its new ID).
   Otherwise the condition is removed and the summary says which and why: a
   condition about a question the survey does not ask would hide the question
   from everyone, or from no-one.
8. **Files the questions need** (the postcode list, D-52) come with them.
9. **Provenance** is added to the draft (§12.5).

The editor then runs the same validation as for any edit, so a copy that would
publish badly (a condition on a later question, a variable clash with the
identity variables) is shown at once with the usual fix.

### 12.4 Why the locks still hold

The Studio refuses a locked questionnaire whose content nothing vouches for
(§4.4, `lockedDifferences`): today only the published version a draft came
from vouches. Copying a validated questionnaire from the library or from
another survey needs two more vouchers, and both are checked on the server
when the version is published, from nothing the editor can change:

- **The instrument library**, frozen exactly as a release freezes it. A
  questionnaire matching it exactly, with its answer options and scoring, is
  accepted.
- **The releases the draft copied from**, named in its provenance by study
  and hash. Each is read from that study's release store and verified against
  its hash before it vouches for anything. Naming a release proves nothing by
  itself: the copy must match what that release froze, exactly. The number of
  releases one publish reads is capped (25).

Every verified release was itself published through these checks, so a
questionnaire that matches one exactly is the licensed questionnaire. The
editor applies the same two vouchers (it reads the same releases from the
public store), so a copy never looks ready in the Studio and is then refused.

Consent and identity modules are not vouched for by another survey's release:
approval of their wording is per study. One copied in must be unlocked with a
reason (§12.2), which is recorded and audited as unlocking is today.

### 12.5 Provenance

The draft gains `imports`: one entry per piece added, never edited by hand:

```jsonc
{
  "id": "imp_…",                 // random
  "at": "2026-10-06T14:03:11Z", "by": "<uid>", "byEmail": "a@b.c",
  "origin": { "kind": "release", "study": "ybm", "surveyId": "ybm_nd2026_standard",
              "version": "8.0.0", "hash": "sha256:…" }
          // or { "kind": "validated", "instrument": "sdq25_s", "refKey": "sdq25_s@2.0/en-GB/self/standard" }
          // or { "kind": "module", "moduleId": "sleep_habits", "version": 3, "contentHash": "sha256:…" },
  "items":   { "<new question ID>": "<question ID in the source>" },
  "renamed": { "<source ID>": "<new ID>" },          // only when renamed
  "variablesRenamed": { "<source variable>": "<new variable>" },
  "dismissed": 4                                     // modules only: a newer version the team chose not to take
}
```

Publishing copies the entries for the questions the version still asks onto
the version document (`VersionDoc.imports`), and the provenance export (§10.2)
gains a "copied from" column per question. The release itself is unchanged:
provenance is about how a survey was built, and lives with its history, not in
what the iPad runs.

### 12.6 Saved modules

**Saving.** From a block's menu, "Save to library…": a title, a description,
tags, and which of the block's questions (all by default). Only editable
content can be saved: validated questionnaires are already a shelf, and the
consent and identity modules belong to their study. Unpublished questions can
be saved; whatever survey uses them later publishes them through every check.

**Storage.** Project-wide, beside the studies, because the point is reuse
across them:

- `studioLibrary/{moduleId}`: `title`, `description`, `tags`,
  `latestVersion`, `createdAt`/`createdBy`, `updatedAt`, `retired`.
- `studioLibrary/{moduleId}/versions/{n}`: the piece as canonical JSON, its
  SHA-256 `contentHash`, a note on what changed, who saved it and when, and the
  survey it was saved from. **Versions are immutable**; saving again makes
  version n+1. A save made against a version that is no longer the latest is
  refused, so two people cannot silently overwrite each other.

Both are written only by functions, which check the piece (the schema, the
size, no locked or protected content, conditions only about questions inside
it) and write the audit row in the saving study's audit trail. Browsers read
the library only through functions, which check the caller's Studio access.

**Who.** Anyone with editor access to a study's Studio may save a module, or a
new version of one, and edit its title, description and tags. Retiring a
module (it leaves the shelf; surveys using it keep their copies) is for its
creator or a project owner. Nothing is ever deleted.

**Update notices.** A block whose questions came from a saved module, where the
module now has a later version than the one copied and that version has not
been dismissed, shows "A newer version of *Sleep habits* is in the library
(v4)". "Review" shows what would change; "Update this survey's copy" applies
it as one draft edit (`updateFromModule`), question by question, three ways
(the copied version, the newer version, the draft):

| The draft's question | In the newer version | Result |
|---|---|---|
| unchanged since copied | changed | takes the newer wording/options |
| changed here | unchanged | keeps this survey's |
| changed here | changed | keeps this survey's, and says so |
| unchanged since copied | removed | archived (its ID stays reserved) |
| changed here | removed | kept, and says so |
| — | added | added, by the §12.3 rules |

"Not now" records the version as dismissed; a later version notifies again.
Nothing changes in a survey until somebody chooses to update it, and an update
is published like any other change, with the bump it calls for (an option
code changing meaning is refused as always, §4.4).

### 12.7 Copying a whole survey from another study

"New survey → Copy a published version" offers every study's surveys, not only
this study's. The copy remembers where it came from (`basedOn`, which now
carries the source's study), and its first publish checks its locked and
protected content against that release, read from the source study's store
and verified, exactly as a copy within a study is checked today.

A copy from another study carries that study's consent and identity modules
unchanged and still protected. The dialog says so before the copy is made:
the new study's ethics approval must cover them, or they are unlocked (with
the reason recorded) and changed.

### 12.8 Access and security

- **Browsing.** Anyone with Studio access (viewer or above) to the study they
  are working in can browse every shelf, including other studies' published
  surveys. Those are the questionnaires participants are shown, already
  public by hash; the library adds a list of them for the project's
  researchers, never for the public. No sitting, narrative, draft or access
  list of another study is read.
- **Adding to a draft** needs editor access to that draft's study, as any edit.
- **Saving modules** needs editor access to the study saved from (§12.6).
- **Copying a survey from another study** needs editor access to the new
  survey's study; the source must be a published version.
- The server never trusts the editor's say-so: provenance names releases; the
  server verifies them by hash and compares content exactly (§12.4).
- `studioLibrary` is closed to browsers in the rules; functions alone read
  and write it.

### 12.9 What does not change

The participant app, the release format and its hash, the publish gate, the
dashboard's data contract (§11.6), the iPads, and every existing draft and
version. A draft without `imports` is read as having none. Nothing is
migrated.

### 12.10 Decisions for the research team to confirm

1. **Every Studio member can browse every study's published surveys** in the
   library (not their drafts, data or access lists).
2. **Saved modules are shared across all study spaces.** Any Studio editor may
   save or improve one; only its creator or an owner retires one; nothing is
   deleted.
3. **Validated questionnaires are added whole and unchanged.**
4. **The consent and identity modules can be copied only with a recorded
   reason**, because their approval is per study.
5. **A copy keeps its question ID and variable**, renamed only on a clash, and
   every rename is reported.
6. **Update notices are for saved modules only.** A question copied from a
   published survey stays as it was copied; the source survey's later
   versions do not notify.
