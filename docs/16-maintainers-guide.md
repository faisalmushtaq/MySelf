# MySelf — maintainer's guide

For whoever picks this repository up next: a researcher changing a question, or a
developer changing the code. It says where things are, how a question travels
from the library to a row in the dataset, and how to make the common changes
without breaking the one promise the platform makes — that the answer recorded
is the answer given, read through the questionnaire it was given under.

The other documents say *why* things are the way they are. This one says *where*
and *how*, and points at them for the rest. Operational instructions for fielding
are in [15-fielding-runbook.md](15-fielding-runbook.md); what is and is not ready
is in [14-readiness-audit.md](14-readiness-audit.md) §8 onwards.

---

## 0. The first hour

Node 22 or later and pnpm 10 or later (`engines` in the root `package.json`).

```sh
pnpm install
pnpm -r build          # packages import each other's dist/, so build before testing
pnpm -r typecheck
pnpm test              # every unit suite (pnpm -r test)
cd apps/participant && pnpm dev    # the survey, at the address Vite prints, under /MySelf/
```

A build with no study configured stores everything on the device and sends
nothing anywhere, which is what you want on a development machine.

---

## 1. What is where

A pnpm workspace: shared code in `packages/`, things that run in `apps/`.

| Path | What it is |
|---|---|
| `packages/schema` | The definition layer: Zod schemas for items, response scales, instruments, compositions and release manifests. Everything else is typed from here. `published.ts` describes a version published from the dashboard (D-54): where it lives, its shape, and the hash check every reader makes before using one. |
| `packages/engine` | The survey runtime, pure and deterministic: the walker (what is visible, where Next and Back land), display logic, answer store, consistency checks, and the postcode and street list parsers. Runs the same on the iPad and in Node. |
| `packages/library` | The questionnaire content: validated instruments (`instruments.ts`), the study's own modules (`modules.ts`) and response scales (`scales.ts`). |
| `packages/scoring` | Scoring definitions for the instruments and the executor that applies them. |
| `packages/release` | The release builder and publish gate: resolves the composition (`compose-ybm.ts`) against the library, checks it, and freezes it into a content-hashed manifest. `publish.mjs` writes one to `releases/`. |
| `packages/store` | Turning a device's event log into a dataset (`ingest.ts`), the identity rules (`identity.ts`), BIDS export, and the encrypted handover envelope. |
| `packages/firebase` | How a study is laid out in Firestore, and the rule that a stored sitting is never overwritten. |
| `packages/narrative` | MyStory, the micro-narrative module: protocol format, runner, prompts, and a `check` command for protocol files in `protocols/`. |
| `packages/llm` | The gateway to a language model, with mock, OpenAI and relay adapters. |
| `apps/participant` | MySelf Go, the PWA children use on iPads. Offline-first; answers are encrypted in IndexedDB before the screen moves on. |
| `apps/researcher` | The researcher view: pulls sittings, builds the dataset in the browser, exports. |
| `apps/functions` | The Firebase backend: `saveSitting` (uploads), `captureIdentity`, the nightly export, the LLM relay, administration. |
| `apps/api` | A self-hosted Postgres alternative to `apps/functions` ([12-server-deployment.md](12-server-deployment.md)). Nothing deployed calls it. |
| `apps/mystory-lab` | A standalone page for running a narrative protocol without the survey, for iterating on prompts. |
| `releases/` | Frozen release manifests, one per published version, and `releases/assets/`, the dated files a release pins by hash (postcode and street lists). Never edited once committed. |
| `scripts/` | Builders for the release assets (`build-postcodes.mjs`, `build-streets.mjs`), the app icons, and `pull-releases.mjs`, which copies versions published from the dashboard into `releases/` (§3.6). |
| `e2e/`, `e2e-sync/` | Browser tests (Playwright). `e2e/support/walker.ts` is the survey walk the suites share. |
| `infra/` | Firebase configuration and security rules (`infra/firebase/`), and the Docker stack for the self-hosted route. |
| `migration/decisions.yaml` | The decision register, D-01 to D-41. Later decisions are written up in the document they concern (§6). |
| `source-materials/` | The original Qualtrics exports and the KCL micro-narratives code this was built from. Read-only. |

Dependencies run one way. `schema` and `llm` depend on nothing in the
repository; `engine`, `library` and `scoring` build on `schema`; `store` on
`engine` and `scoring`; `firebase` on `store`; `narrative` on `llm`; `release` on
`library`, `scoring` and `narrative`. The apps sit on top, and no package imports
an app.

### Inside the participant app

| Path | What it is |
|---|---|
| `src/main.tsx` | Start-up: chooses the version to run (or, with `?preview=1`, waits for a draft from the dashboard), then loads App. |
| `src/App.tsx` | The sitting as a state machine (start, running, check-in, pace, review, finished), every write to storage, and the sync timers. The sitting's state lives here. It builds its screens from the version `main.tsx` chose (`lib/running.ts`). |
| `src/screens/` | The screens App shows between questions: start (with the researcher's `HandoverPanel`), check-in, "No rush", finish, and "Let's pause a moment" when a save fails. Presentational only: they take what they show as props and report taps back. |
| `src/components/SurveyScreen.tsx` | One question per screen: the stem, the control, Next, Back, skipping and the effort prompts. |
| `src/components/ReviewScreen.tsx` | The list of answers, offered from the finish screen (D-31). |
| `src/components/controls/` | One file per response type (`SingleChoice.tsx`, `NumericControl.tsx`, `FormFieldsControl.tsx` …). `shared.ts` holds the props they all take; import them from `index.ts`. |
| `src/lib/` | Everything that is not drawing: `flatten.ts` (manifest to screens), `db.ts` and `crypto.ts` (encrypted storage), `sync.ts` (uploads), `export.ts` (the handover file), `postcodes.ts` and `streets.ts` (release assets), `timing.ts`, `pipes.ts`, `durability.ts`, `space.ts`, `updates.ts`. Which version runs (§3.6): `versions.ts` (the rules), `published.ts` (reading the study's database), `bundled.ts` (the release built in), `choice.ts` and `running.ts`. `preview.ts` is the dashboard's preview mode; `narrative.ts` is what passes between the survey and the MyStory module. |

---

## 2. How a question becomes data

1. **Authored** in `packages/library/src`. An item has a key, the variable it is
   exported as, a stem, a response type, and usually a scale key. The library's
   own test parses every record against the schema.
2. **Composed.** `packages/release/src/compose-ybm.ts` places instruments and
   modules in sections, with the conditions that show or hide them.
3. **Frozen.** `buildRelease` (`packages/release/src/builder.ts`) resolves the
   composition against the library, runs the publish gate (unknown references,
   duplicate variables, conditions on answers not yet given, missing assets…),
   and hashes the result. `publish.mjs` writes it to
   `releases/ybm_nd2026_standard_r<version>.manifest.json`. Only the scales an
   item uses are frozen, and the release assets are pinned by SHA-256.
4. **Held still.** The drift test in `packages/release/src/release.test.ts`
   ("a published release never drifts") rebuilds the current release from the
   sources and compares hashes. If you change the library or the composition,
   this test fails — and that is its job: the sources no longer describe the
   release devices are running. The answer is a new release (§3.4), never a
   weaker test.
5. **Shown.** The participant app runs one manifest at a time: the version the
   study has made active, or the one bundled into it (§3.6). `lib/flatten.ts`
   turns it into an ordered list of screens; the engine's `Walker` decides what is
   visible and where Next and Back go; `SurveyScreen` renders every control and
   each one draws itself only for its own response type.
6. **Recorded.** Every answer, skip and navigation is appended as an event to the
   sitting's log in encrypted IndexedDB before the screen advances. The sitting
   carries the hash of the release it was started under.
7. **Sent.** `lib/sync.ts` uploads finished sittings, and checkpoints of
   unfinished ones, to `saveSitting` (`apps/functions/src/sittings.ts`), which
   stores each sitting as one Firestore document, with chunks beside it if it is
   too big for one (layout in `packages/firebase/src/layout.ts`). Whatever the
   network, a researcher can also write every sitting on the iPad to an
   encrypted file from the handover panel on the start screen (`lib/export.ts`).
8. **Read.** `ingest` (`packages/store/src/ingest.ts`) turns a sitting's log into
   rows, reading it through the release whose hash it carries — never the latest
   one. The researcher view (`apps/researcher/src/lib/build.ts`) and the nightly
   export (`apps/functions/src/export.ts`) both call it.
9. **Identity kept apart.** An item marked `identifying: true` in the library
   (names, date of birth, address) is routed to the identity partition at ingest
   and never appears in research rows or exports. On Firebase, `captureIdentity`
   (`apps/functions/src/identity.ts`) files it in a separate project
   ([13-firebase.md](13-firebase.md) §1). Marking an item is a data-handling
   decision, which is why it is frozen into the release.

---

## 3. Making changes

Every change to the questionnaire — what a participant sees, or how an answer is
coded or scored — ends in a new release. Plan for it from the start: note the
decision (§6), make the change, cut the release, update the documents.

### 3.1 Change a question, or add one

1. Edit the record in `packages/library/src/instruments.ts` (published
   instruments) or `modules.ts` (the study's own questions). A new item goes in
   its form's `items`; copy the shape of a neighbour. A new instrument or module
   also goes in `allInstruments` or `allModules`, and in the composition
   (`packages/release/src/compose-ybm.ts`).
2. If the answer could identify someone, set `identifying: true`.
3. Record the change in the record's `researcherNote` or `changelog` with its
   decision number, as the records around it do.
4. `pnpm -r build && pnpm test`. Expect the drift test to fail; everything else
   should pass. Then cut a release (§3.4).
5. Update [03-instrument-library.md](03-instrument-library.md) and write the
   change up in [06-data-model-identifiers-versioning.md](06-data-model-identifiers-versioning.md) §6.

Published instruments are licensed: wording, options and order are the
published ones, and a deliberate departure is a recorded decision.

### 3.2 Add a response scale

1. Add a `ResponseScale` to `packages/library/src/scales.ts` — a `key` of the
   form `scale.<name>`, a `version`, a `name`, a `direction`, and options built
   with `opt(code, label, legacyCode?, kind?)` — and list it in `allScales`.
2. Refer to it from items by its key (`scale: "scale.<name>"`). A scale no item
   uses is not frozen into a release, so adding one changes nothing until an
   item points at it.
3. **Codes are what is stored.** Never renumber an existing scale's codes, and
   never reuse one for a different meaning ([07-migration-strategy.md](07-migration-strategy.md) §2).
   Reordering or relabelling options is a new scale version, and the codes stay
   as they were (see the ethnicity list's 2.0.0 note, D-53).
4. Grouping bands (`bands`) and the other scale fields are defined in
   `packages/schema/src/response-scale.ts`; the publish gate refuses bands that
   group codes the scale does not have.

### 3.3 Add a field to the schema

1. Add it to the Zod schema in `packages/schema/src` — `item.ts` for an item,
   `response-scale.ts` for a scale, `assessment.ts` for the composition and
   manifest.
2. **Keep every published manifest readable.** The researcher view and the
   functions read each sitting through the manifest it was collected under, and
   both quietly skip a manifest that no longer parses — its sittings become
   unreadable. So a new field must be `.optional()` or have a `.default()`.
   `packages/release/src/published.test.ts` enforces this. It checks that every
   fielded release (r5.0.0 on) still parses, still carries its hash and was
   never edited. r1–r4 and `preview.manifest.json` predate fielding and are
   exempt. Two more tests check that each loader actually keeps every fielded
   release: `apps/functions/src/releases.test.ts` and
   `apps/researcher/src/releases.test.ts`. The schema is read from its build,
   so run `pnpm --filter @myself/schema build` (or `pnpm -r build`) before the
   tests after a schema change.

3. The builder parses every record before hashing it, so a `.default()` is
   filled in on each one, the frozen content changes, and the drift test fails:
   a defaulted field ships with a new release. An `.optional()` field that
   nothing sets leaves the hash alone.
4. If the field refers to something else — another item, a scale's codes, a
   release asset — add a check to the publish gate in
   `packages/release/src/builder.ts`, with a test in `release.test.ts`
   (`bands`, `confirmAbove`, `postcodeCheck` and `streetCheck` are examples).
5. Use it where it matters: the control in `apps/participant/src/components/controls/`,
   the engine if it changes what is visible or valid, and `ingest` if it changes
   what is stored. If the engine's behaviour changes, bump the version in
   `packages/engine/package.json`, `ENGINE_VERSION` in
   `packages/engine/src/version.ts` (a test holds the two together) and
   `engineVersion` in `packages/release/publish.mjs` to match, as r8.0.0 and
   r9.0.0 did. A device runs a published version only if its engine has the
   same MAJOR and a MINOR at least the release's (§3.6), so a MINOR bump is
   what stops an older build running a release that needs the new behaviour.

**A new response type** is the same, further: a new branch of `itemDefinition`
in `packages/schema/src/item.ts`; if it needs one, a new answer kind in
`packages/engine/src/answers.ts`; a control in
`apps/participant/src/components/controls/`, exported from `index.ts` and added
to the list in `SurveyScreen.tsx`; its wording in `describeAnswer`
(`ReviewScreen.tsx`); its cells in `packages/store/src/ingest.ts`; and a branch
in each end-to-end walk's answering function.

### 3.4 Cut a release

Versions follow the adapted semver in [06-data-model-identifiers-versioning.md](06-data-model-identifiers-versioning.md) §3.
The rule that surprises people: **anything a participant reads, selects, or how an
answer is coded is MAJOR** — a one-character typo fix in a stem included. MINOR
is additions that leave existing data meaning intact; PATCH is corrections
invisible to participants and analysts, such as a licence-status update. In
practice most releases are MAJOR.

1. `pnpm -r build` — `publish.mjs` runs from the built packages.
2. Publish, naming the decisions it carries and who is publishing:

   ```sh
   node packages/release/publish.mjs 10.0.0 D-54 --by <github-username>
   ```

   It writes `releases/ybm_nd2026_standard_r10.0.0.manifest.json` and prints the
   release key and hash. `--at <ISO time>` sets the publication time (default:
   now).
3. Point everything at the new release. These are the places r9.0.0 is named:
   - `packages/release/src/release.test.ts` — `meta` (copy `version`,
     `publishedAt`, `publishedBy`, `engineVersion` and `decisionRefs` from the
     new manifest's `release` block), the drift test's path, and the header
     comment;
   - `apps/participant/src/lib/bundled.ts` — the `rawManifest` import, and the
     header comment;
   - `apps/participant/src/flatten.test.ts` — `currentManifest`;
   - `apps/functions/src/releases.ts` — import it and add it to `published`.
     Never remove an older one: sittings collected under it are read through it.
     `releases.test.ts` beside it fails until you do;
   - `e2e/accuracy.spec.ts` — `MANIFEST`.

   The researcher view loads every file in `releases/` by itself.
4. Run everything in §4. The drift test now holds the new file.
5. Write the release up in docs/06 §6, under its decision number.

A committed manifest is never edited. A mistake in one is corrected by the next
release, and the old one stays readable for the sittings collected under it.

### 3.5 Add a release asset

A release asset is a data file the survey needs on the device — at present the
West Yorkshire postcode list (D-52) and street list (D-53). The pattern:

1. **Build it with a script** in `scripts/`, from a named source with its licence
   recorded in the script's header (`build-postcodes.mjs` and
   `build-streets.mjs` are the examples; each prints its usage). Write it to
   `releases/assets/`, dated by the data's own edition. A newer edition is a new
   file, never an edit to one a release already pins.
2. **Register it** in `ASSET_FILES` in `packages/release/src/assets.ts`, under
   the key items will name it by. The release pins its path, SHA-256 and size.
3. **Name it from the item** that needs it, through a schema field (as
   `postcodeCheck.asset` and `streetCheck.asset` do), and add a publish-gate check
   that the asset exists, so a release cannot point at a list it does not carry.
4. **Carry it in the app**: a loader in `apps/participant/src/lib/` keyed by the
   asset key. `postcodes.ts` bundles its list into the app; `streets.ts` loads its
   list as a separate chunk only when it is needed, which keeps the main bundle
   the size it was (the service worker still precaches it). Add a test that the
   bundled text hashes to what the release pins — see "checks postcodes against
   exactly the list the release pins" in `flatten.test.ts`.
5. **Parse it in the engine** (`packages/engine/src/postcodes.ts` and
   `streets.ts` are the examples), with tests against the committed file.

The asset reaches participants only with a release that pins it, on a build that
carries it. A version published from the dashboard (§3.6) can use only the assets
the deployed app already carries; one naming an asset it does not carry runs
without that check, as an unknown asset always has.

### 3.6 Versions published from the dashboard (D-54)

The dashboard's survey editor publishes a version **straight to the live
survey**, with no code change and no deploy. It builds the version with this
repository's own `buildRelease`, so it is a release like any other: a frozen,
hashed manifest. The design is in [06-data-model-identifiers-versioning.md](06-data-model-identifiers-versioning.md)
("Versions published from the dashboard"); the dashboard's side is its docs/11.

**Where it lives.** The dashboard's functions write two documents to this
study's database with the Admin SDK:

- `studies/{study}/releases/{hash}`: `{ hash, version, key, study, publishedAt,
  publishedBy, engineVersion, manifestJson, source, notes? }`, where
  `manifestJson` is the whole manifest as JSON;
- `studies/{study}/config/activeRelease`: `{ hash, version, key, activatedAt,
  activatedBy }`, the version new sittings use.

Anyone may read both and no client may write either (`infra/firebase/firestore.rules`).
The shape, the paths and the check are in `packages/schema/src/published.ts`.

**How an iPad picks its version** (`apps/participant/src/lib/versions.ts`):

1. A sitting is finished under the version it started with. If a participant's
   code has an unfinished sitting under another version, the start screen reloads
   into that version and carries on (`reopenUnderItsVersion` in `App.tsx`).
2. Otherwise it reads `activeRelease`, waiting at most 4 s. A version it has not
   stored is fetched (at most 8 s more) and used only if its manifest hashes to
   the hash it was published under, the schema accepts it, the app's engine can
   run it (the same MAJOR, and a MINOR no newer than `ENGINE_VERSION`), and the
   app can draw it. It is then stored in IndexedDB.
3. If anything fails, or there is no network, it runs the last active version it
   stored, and failing that the one bundled into the build (`lib/bundled.ts`).

A build with no Firebase project, such as the preview channel, asks nobody and
runs the bundled release. After every handover a device asks again, and reloads
onto a new version at the start screen, never in the middle of a sitting. The
build line on the start screen says which version is running and where it came
from ("live", "live when last checked", "built in", "finishing a sitting"), and
why the live one is not running when that is so. Tap it five times, as ever, for
the staff panel.

**Once the study has made a version active, it decides what devices run.** A
release cut here with `publish.mjs` and deployed is the bundled fallback; to make
it the live version on devices, make it active in the dashboard's Versions page.

**Everything that reads sittings knows the published versions too.** The
functions read them from the database, cached for a minute and checked against
their hash (`knownReleases` and `releaseFor` in `apps/functions/src/releases.ts`),
for identity capture, the export, and the model configs the MyStory relay allows
a device. The researcher view reads them on signing in and before every pull
(`addPublishedReleases` in `apps/researcher/src/lib/releases.ts`). A document
that does not match its hash is reported and never used.

**MyStory.** A version that ends with MyStory runs the questions, then MyStory,
then the finish screen, then the handover. The survey sends the embedded module
the protocol frozen into the version (`myself:narrative-protocol`, after the
module says `mystory:ready`), and the module runs that protocol or refuses to
start; it never falls back to its own copy. The messages are described in
`apps/participant/src/lib/narrative.ts` and `apps/mystory-lab/web/host-protocol.ts`.

**Preview.** The editor opens the survey with `?preview=1` in an iframe. The app
says `myself:preview-ready` and runs the draft the dashboard answers with
(`myself:preview-manifest`), from the dashboard's own origins only
(`lib/preview.ts`). Nothing is stored or sent, MyStory's place is shown rather
than run, and a banner says "Preview — nothing is saved".

**Bringing published versions into git.** `scripts/pull-releases.mjs` copies
every published version into `releases/`, named as `publish.mjs` names them, so
the repository keeps the whole history and `published.test.ts` checks them like
the rest:

```sh
pnpm -r build                                   # the script reads @myself/schema's build
export GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>   # or: gcloud auth application-default login
node scripts/pull-releases.mjs --dry-run        # list what is published, and what would be written
node scripts/pull-releases.mjs                  # write the new ones
```

`--project` and `--study` default to `myself-research` and `ybm`. It refuses a
manifest that does not hash to the hash it is filed under, and never overwrites
a file: the same hash is left alone, and a different manifest under a version
number already committed is refused. Either refusal exits non-zero. Then, as for
any release (§3.4): add each new file to `published` in
`apps/functions/src/releases.ts` (its test fails until you do), run the tests,
and commit. Pulling is for the record; devices and the functions already have
the versions from the database.

---

## 4. Running the tests

| Suite | Command | Needs |
|---|---|---|
| Unit, every package and app | `pnpm -r build && pnpm test` | nothing else |
| One package | `pnpm --filter @myself/participant test` | a build of its dependencies |
| Types | `pnpm -r typecheck` | |
| Browser: the survey, offline, resumed, handed over, the dataset against what was tapped, and a draft previewed from the dashboard | `pnpm test:e2e` | Playwright's browsers |
| Functions against a real Firestore, including versions published from the dashboard | `pnpm --filter @myself/functions test:integration` | Java 17+ |
| The whole chain: browser → HTTP → Firestore, and a version made active in the database reaching the iPad (`e2e-sync/releases.spec.ts`) | `pnpm test:e2e:sync` | Java 17+, Playwright's Chromium |
| Firestore security rules | `cd infra/firebase/test && npm install && npm test` | Java 17+ |

The three emulator suites start the Firestore emulator on port 8181 themselves,
downloading it on first run; run them one at a time. The survey suite also
serves a stand-in dashboard on port 4183 (its own port plus ten) for the preview
test.

**Browser tests on a machine without Playwright's own browsers** — a sandbox, or
anywhere `playwright install` is not allowed — point at a Chromium you have and
run only that engine:

```sh
CI=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npx playwright test --project=chromium
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm test:e2e:sync
```

`CI=1` matters for the first. Without it the suite reuses any server already
listening on port 4173, so a preview left running from another checkout would be
the thing tested. With it, Playwright builds and serves this checkout, and stops
if the port is taken. The sync suite (port 4174) always builds its own. Both
suites build the participant app themselves, so they cannot pass against a stale
`dist/`. CI runs WebKit too, because an iPad is WebKit.

---

## 5. Deploying

Everything deploys from GitHub Actions (`.github/workflows/`):

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push and pull request | build, typecheck and unit tests; browser tests on Chromium and WebKit; the functions integration, sync and rules suites |
| `pages.yml` | push to `main` | builds with the study's Firebase project baked in, runs the unit tests, and publishes the participant app to GitHub Pages at https://faisalmushtaq.github.io/MySelf/, with the researcher view at `/researcher/` and the MyStory lab at `/mystory/` |
| `firebase.yml` | push to `main`, or run by hand | deploys Firebase Hosting (the MyStory lab) every time; the Firestore and Storage rules when their files changed; the functions when `apps/functions`, `releases/`, the Firebase configuration or one of the packages it lists (`llm`, `narrative`, `firebase`, `schema`, `store`) changed |
| `preview.yml` | push to the working branch it names, or run by hand | publishes the survey to the Firebase Hosting preview channel `survey-preview` for 30 days, and prints its URL in the run summary |

Two things to know about `firebase.yml`:

- It decides what changed from **the last commit of the push only**
  (`git diff HEAD^ HEAD`). If a push of several commits changed the functions in
  an earlier one, they are not redeployed. Neither are they after a change to
  `packages/engine` or `packages/scoring`, which the functions use through
  `packages/store` but the workflow does not list. In either case, run it by
  hand with "Deploy the functions as well" ticked.
- It needs the repository secret `FIREBASE_SERVICE_ACCOUNT`
  ([13-firebase.md](13-firebase.md) §5.2.1). The functions are bundled for
  deployment by `apps/functions/build-deploy.mjs`, which Firebase runs as the
  `predeploy` step in `infra/firebase/firebase.json`; the bundle is gitignored.

The first-time Firebase setup, the two projects, and granting the first owner are
in [13-firebase.md](13-firebase.md). The self-hosted route is in
[12-server-deployment.md](12-server-deployment.md).

---

## 6. House style

- **Comments say why.** The code is commented at length on purpose: a
  questionnaire outlives its authors, and the reason for an odd-looking line is
  often a lost morning of data. Keep the reasons when you move code; add one
  when you make a choice.
- **Decisions have numbers.** D-01 to D-41 are in `migration/decisions.yaml`.
  From D-42 on, each is written up in the document it concerns — questionnaire and
  release changes in docs/06 §6 (D-49 to D-53), Firebase in docs/13, MyStory in
  docs/08. Take the next unused number and cite it in code, commits and the
  manifest (`publish.mjs … D-54`).
- **Plain British English**, for participants above all: see the style guide,
  [11-style-guide.md](11-style-guide.md), for how screens look and read.
- **Frozen means frozen.** Committed manifests and dated release assets are never
  edited. Corrections are new releases and new files.
