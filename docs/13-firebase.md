# MySelf on Firebase

Supersedes the self-hosted stack in `docs/12` (D-39). That stack still works
and is still in the repository; this is the one being deployed.

---

## 1. Two projects, and why

| Project | Holds | Reached by |
|---|---|---|
| `myself-research` | raw event logs, corrections, twin splits, devices, audit | the researcher view, the iPads, the functions |
| `myself-identity` | names, dates of birth, code components, UPNs, NHS numbers, relationships, access log | **only** Cloud Functions, using a service account granted access deliberately |

On Postgres the separation was a database role with no grant on the identity
schema. Here it is a **project boundary** — the strongest control Firebase
offers. A security rule is a file one bad edit away from being wrong; a project
your credentials do not reach is not.

Nothing in a browser ever touches the identity project. Names go in through a
Firestore trigger and come out through owner-only callables, so a child's name
never passes through a researcher's laptop on its way to storage. That is a
materially better position than the file-based route it replaces.

---

## 2. How the data sits

```
studies/{study}                 the study's registry document (D-56): title, open or closed
studies/{study}/
  sessions/{sessionId}          one document per sitting, whole event log inside
    chunks/{0000…}              only when a log is too big to fit — rare
  quarantine/{id}               sittings that arrived twice from different iPads
  corrections/{id}              mistyped-code repairs
  assignments/{sessionId}       twin splits
  devices/{deviceId}            enrolled iPads
  audit/{id}                    who did what
```

**One project, several studies (D-56).** Everything above is per study. `ybm`
is the project's default study and needs no registry document; any other
**study space** is created by a project owner in the Studio, which writes its
`studies/{study}` document (public by `get`: its title and status, so an iPad
can tell a closed study) and makes its creator its first Studio admin. Every
function that takes a study checks it against that document first, and does
everything else in that study: an iPad is registered per study, MyStory's
limits are counted per study, releases are read from the study's own store,
and the nightly export writes `exports/studies/{study}/{date}/` for each study
other than `ybm`. The paths, fields and how to attribute a sitting to a study
and a survey are in docs/16 §11.6.

**One document per sitting** is the decision that keeps this in the free tier. A
whole event log is ~54 kB against a 1 MiB limit, so deriving the dataset costs
one read per sitting: 1,000 sittings is 1,000 reads, not 295,000.

**Chunking** exists for the sitting somebody left open across a fortnight.
Chunks are packed to a **byte budget**, not an event count — 250 ordinary events
and 250 carrying long free-text answers are very different documents, and only
size is what Firestore refuses. Getting this wrong fails the write and loses the
sitting at the moment it is handed over, which is why it has its own tests.

---

## 3. Who can do what

Roles are Firebase Auth custom claims, set by an owner through `setRole`.

| | owner | researcher | analyst | iPad |
|---|---|---|---|---|
| read the study | ✓ | ✓ | ✓ | ✗ |
| add a sitting | ✗ | ✗ | ✗ | ✓ |
| record a correction or twin split | ✓ | ✓ | ✗ | ✗ |
| enrol or revoke a device | ✓ | ✗ | ✗ | ✗ |
| read a name | ✓ | ✗ | ✗ | ✗ |
| edit a raw log | **nobody** | | | |
| delete a sitting | **nobody** | | | |

A signed-in account with **no role** can do nothing and is told so plainly —
silence looks like a bug and invites a workaround.

The claims are the project's, so they reach **every** study: an owner,
researcher or analyst reads sittings in each study space as in `ybm`, and may
list the registry and each study's live surveys (the dashboard's way in). Only
an owner creates, closes or reopens a study space. **MySelf Studio** access is
per study (each study's own `studioMembers` list, docs/16 §5.7, §11.5): a
Studio role in one study is nothing in another, in the rules and in the
functions.

An iPad can post sittings and **read nothing**. A stolen device is a device that
can write, not a window into the cohort.

### The rules are tested

`infra/firebase/test/` runs 20 tests against the real Firestore emulator,
exercising each rule from **both sides** — the caller who should pass and the
caller who should not. A rules suite that only checks the happy path proves
nothing; the value of a rule is what it refuses.

```bash
cd infra/firebase/test && npm test
```

Run this before every rules deploy. On Firebase the rules *are* the access
control, so an untested rules change is an untested security change.

---

## 4. Exports and folders

Unchanged from `docs/06` — the BIDS tree is built by `@myself/store`, which has
no idea where the logs came from. Three routes:

1. **Click it.** The researcher view builds the zip in the browser.
2. **Nightly.** `nightlyExport` writes the tree to Cloud Storage under
   `exports/YYYY-MM-DD/…`, plus a `bids.zip` beside it. Object names contain
   slashes, so the console renders them as real folders. Every other study
   space with sittings is written beside it under
   `exports/studies/<study>/YYYY-MM-DD/…` (D-56); one study failing does not
   stop the others.
3. **Sync it.** `gsutil -m rsync -r gs://…/exports/2026-09-01 ./ybm-bids`.

Two different backups, commonly conflated:

- **Firestore scheduled export** — restores the system. Managed by Google.
- **The BIDS snapshot** — *is* the data, readable in thirty years. This is the
  archival copy and the deposit.

If a twin collision is unresolved when an export runs, it is written anyway —
withholding it helps nobody — and logged as an **error**, because that export
describes two children as one person.

---

## 5. Setting it up

```bash
# once, per project
firebase projects:create myself-research
firebase projects:create myself-identity

# Firestore location is permanent — choose europe-west2 (London) and check twice
firebase firestore:databases:create "(default)" --location europe-west2 --project myself-research
firebase firestore:databases:create "(default)" --location europe-west2 --project myself-identity

# rules
firebase deploy --only firestore:rules,storage --project myself-research
firebase deploy --only firestore:rules --project myself-identity --config identity.firebase.json

# let the research project's functions reach the identity project
gcloud projects add-iam-policy-binding myself-identity \
  --member="serviceAccount:myself-research@appspot.gserviceaccount.com" \
  --role="roles/datastore.user"

firebase deploy --only functions --project myself-research
```

Then make yourself an owner once. Somebody has to be first, and being first
cannot be done through a permission check nobody can yet pass — so this runs on
a laptop against Google's application-default credentials, and can only do what
that person could already do in the console.

Sign in to the app with that address FIRST — an account is created by signing
in, not by being named here.

```bash
# With gcloud:
gcloud auth application-default login
pnpm --filter @myself/functions grant you@leeds.ac.uk owner --project myself-research

# Without installing anything: Firebase console -> Project settings ->
# Service accounts -> Generate new private key, then
pnpm --filter @myself/functions grant you@leeds.ac.uk owner \
  --project myself-research --key-file ~/Downloads/key.json
```

Delete the key file afterwards. It is a credential to the whole project, and
the reason to prefer gcloud where it is available is that gcloud's credentials
expire and a downloaded key does not.

Sign out and back in afterwards: a role arrives in a new token, not the one you
are already holding.

After that, every other account is administered through the researcher view.

### 5.1 The model relay, and the OpenAI key (D-45)

MyStory needs model calls made from an iPad in a school and from a page on the
open web, and **neither may hold the key**. A key in a page is readable by
anyone with the page; a key on a device is a key in a school. So the key lives
in Secret Manager, is read into one Cloud Function, and never leaves it.

```bash
cd infra/firebase

# Paste the key when prompted. It is not echoed, not logged, and not in git.
firebase functions:secrets:set OPENAI_API_KEY --project myself-research

firebase deploy --only functions:llmRelay --project myself-research
# prints: https://europe-west2-myself-research.cloudfunctions.net/llmRelay
```

**The region is set in `apps.ts`, not `index.ts`.** ES modules evaluate
imports before the importing module's body, so `setGlobalOptions` in the entry
point ran after every re-exported module had already defined its functions —
the region silently did not apply, and all twelve would have deployed to
us-central1, the wrong continent from a Firestore location that is permanent.
It now lives in the module every function file imports, and a test reads the
region off each endpoint the way the CLI does.

**The packaging step runs `npm install` in the output directory.** Not for the
cloud, which installs again from the generated package.json — for the CLI,
which loads the bundle to discover which functions it exports. Without
node_modules it reports "Couldn't find firebase-functions package in your
source code" and then fails without explanation.

**Where the bundle goes.** Into `infra/firebase/functions/`, beside
`firebase.json`, and gitignored. The CLI refuses a `source` outside the
directory holding `firebase.json` — "is outside of project directory" — so a
bundle written next to the TypeScript cannot be deployed however correct it is.

**Why the functions are bundled before deploying.** Firebase uploads the
functions directory and runs `npm install` inside Google's build environment,
where our five `workspace:*` dependencies mean nothing — a deploy straight from
`apps/functions` fails at the end of a long upload with a message about a
missing package rather than about the workspace. So a predeploy step bundles
everything into one file with the workspace packages and the release manifests
inlined, and deploys from a directory whose `package.json` names only
`firebase-admin` and `firebase-functions`, which npm can actually fetch. The
predeploy hook is in `firebase.json`; there is nothing extra to remember.

Every import is from a narrow subpath (`firebase-functions/logger`,
`firebase-functions/v2/options`) rather than a barrel. The barrels load every
provider including Realtime Database, which drags in `@firebase/database-compat`
and fails on a missing `@firebase/app` — a package nothing here uses.

### 5.2 Two homes for the lab, and why (D-46)

```bash
cd infra/firebase
firebase deploy --only hosting --project myself-research
# https://myself-research.web.app
```

**GitHub Pages stays the public preview.** Mock-only, no sign-in, works on
every device, costs nothing and sends nothing anywhere. That is the link for a
colleague or an ethics committee.

**Firebase Hosting is where signed-in, live calls happen** — and it exists
because of one specific failure. Firebase sign-in completes by redirecting
through `<project>.firebaseapp.com` and handing back. On GitHub Pages those are
different origins, and iOS Safari partitions storage between them, so the
handler cannot read the state it just wrote:

> Unable to process request due to missing initial state. This may happen if
> browser sessionStorage is inaccessible or accidentally cleared.

There is no fix on the page for that; the state genuinely cannot cross those
origins. Served from the project's own hosting there is one origin and nothing
to partition, and sign-in works on an iPad as it does on a laptop.

### 5.2.1 Deploying itself (D-47)

`.github/workflows/firebase.yml` deploys on every push to `main`, so the two
halves of the platform cannot drift — a change reaching the public preview and
not the signed-in site, with nothing on screen to say so but a build stamp
somebody has to notice.

**Hosting goes every time.** Static files; a bad one is undone by the next push.

**Functions only go when function code changed** — `apps/functions`, the
packages they bundle, the release manifests, or the rules. A backend redeploy
has a cold start and a window where the relay is being replaced, and paying
that because somebody edited a document is not free. `workflow_dispatch` with
`functions: true` forces one.

The whole test suite runs first, the same one that guards the Pages deploy: a
backend that fails its tests should not reach a study.

**One secret to add, once.** Firebase console → Project settings → Service
accounts → Generate new private key, then GitHub → Settings → Secrets and
variables → Actions → New repository secret:

    Name:  FIREBASE_SERVICE_ACCOUNT
    Value: the entire contents of the JSON file

Delete the downloaded file afterwards. The workflow writes it to a temp file,
uses it, and shreds it in an `always()` step so it does not outlive the job.

The secret is checked before it is used, because the Firebase CLI's own answer
to a missing credential is `Failed to authenticate, have you run firebase
login?` — true of a laptop, meaningless on a runner, and it sends whoever reads
it looking for the wrong thing. The workflow says instead which of the ways to
get it wrong has happened: not set, not valid JSON, valid JSON but the web app
config rather than a key, or a key for `myself-identity` instead of
`myself-research`. On success it prints the project and the service account
address it is deploying as, which is also the address to grant roles to below.

If the functions step fails on permissions, the service account needs **Cloud
Functions Admin**, **Service Account User**, **Cloud Run Admin** and
**Artifact Registry Writer** — the Firebase Admin SDK account has enough for
Hosting but not always for a functions deploy.

Those four get the deploy as far as the secret. `llmRelay` declares
`secrets: [OPENAI_API_KEY]`, and deploying a function that names a secret
reads the secret's metadata and binds the runtime service account to it, so
the deployer also needs **Secret Manager Admin** — `secretmanager.secrets.get`
plus `setIamPolicy`, which neither Viewer nor Secret Accessor covers between
them. Grant it **on the `OPENAI_API_KEY` secret rather than the project**:
Secret Manager → `OPENAI_API_KEY` → Permissions → Grant access. Project-wide
would let the deployer read every secret the study ever holds, which is a
larger grant than a deploy needs.

The failure arrives late and reads as though the secret is missing —
"Permission 'secretmanager.secrets.get' denied on resource (or it may not
exist)" — when in fact the secret exists and the caller cannot see it.

Last, **Cloud Scheduler Admin**, for `nightlyExport`. A scheduled function is
two things: the function, and a Cloud Scheduler job that calls it. The eleven
HTTP and Firestore-triggered functions deploy without it and the scheduled one
does not, so this appears only once everything else is already working.

Six roles, then, and they surface one deploy at a time because each is checked
only when the deploy reaches the resource that needs it. If a deploy fails on
a permission not listed here, the message names it: read the permission, grant
the role that carries it, and add it to this list.

### 5.3 Pointing the pages at it

Two build-time values, both public, neither secret:

```bash
MYSELF_RELAY_URL='https://europe-west2-<project>.cloudfunctions.net/llmRelay'
MYSELF_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"<project>.firebaseapp.com","projectId":"<project>"}'
```

The web config comes from the Firebase console: **Project settings → Your apps
→ Web app**. A web config is a set of public identifiers — the `apiKey` names a
project, it does not authorise anything. What authorises is the signed-in
account and the security rules. Both are baked in at build time rather than
typed into the page, so nobody can point a page at a different project or a
different endpoint.

Without them a build is **mock-only**, which is exactly what the public preview
should be: the whole journey, every staged record, every failure path, no key
and no cost.

With them the page offers sign-in, and the relay makes calls for whoever is
signed in. Sign-in is scoped to the tab — somebody demonstrating the module on a
borrowed machine should not leave an account behind them.

Give that URL to the apps as `MYSELF_RELAY_URL` at build time. Rotating the key
is `functions:secrets:set` again followed by a redeploy; nothing else changes.

**The caller sends a model config KEY, not model parameters.** Provider, model,
temperature and token ceiling are read from the frozen release manifest bundled
into the function. A tampered page cannot raise the temperature, point the study
at a different model, or ask for ten thousand tokens — and a study's published
parameters stay the parameters it actually ran on, which is the entire reason
for freezing them. The request schema has nowhere to put those fields at all,
which is a stronger guarantee than a check that ignores them.

**A device may only run published configurations.** A signed-in member of the
research team may also run a config a shipped protocol declares but no release
has frozen yet — writing prompts means running a protocol before it is
published, and refusing until it had been through a release would mean
publishing protocols nobody had run. An iPad gets no such latitude: a fielded
run that is not reproducible should not be happening in front of a child.

**A verified token is not a permission.** Google sign-in is open to the world
by design, so anyone at all can arrive holding a valid token for this project.
The relay therefore requires an enrolled device, or an account carrying a role
an owner granted (`owner`, `researcher`, `analyst`). Signing in says who you
are; the role is how the study says it knows you. Without this the public page
would be a stranger's route to the study's OpenAI bill.

**A participant's iPad, under daily limits (D-55).** From 2026-10-06 the
credential an iPad issues itself also buys MyStory's model calls, handed to the
module by the survey. It runs only what the sitting's release froze, and is
capped per iPad (`MYSELF_RELAY_DEVICE_DAILY_LIMIT`, 120) and across all iPads
(`MYSELF_RELAY_DEVICES_DAILY_LIMIT`, 2,000) each day; either at `0` switches it
off. The reasoning is in docs/09 §5, the operating side in docs/15 §10.

**It is metered.** Every call is counted per caller per day (600 by default,
`MYSELF_RELAY_DAILY_LIMIT`; an iPad on its own credential has the limits above
instead), and every call writes a provenance row server-side
— what was sent, which snapshot answered, latency, tokens, and whether it
failed. A relay that will make any number of calls for anyone who asks is a bill
with an API in front of it, and a device's account of a call it did not make is
a guess.

**Origins are a list somebody wrote down** (`*.github.io` and localhost), not
the permissive default.

---

## 6. Cost

Inside the free quotas at this study's size: 1,000 sittings ≈ 54 MB against
1 GiB; a full dataset load ≈ 1,000 reads against 50,000/day.

**Container images are the one cost that accrues without anyone looking.** Each
deploy builds an image per function into Artifact Registry, and the deploy
prompts for how long to keep them. They are build artifacts: the running
function does not need old ones, and their only use is rolling back. A year's
retention across a period of iterating on prompts is gigabytes nobody reads.

```bash
firebase functions:artifacts:setpolicy --location europe-west2 --days 7 --project myself-research
```

Note `--location`: the CLI defaults to `us-central1`, which is not where these
functions are, so without it you set a policy on an empty registry and leave the
real one alone. Seven days is enough to roll back a bad deploy and not enough to
hoard; Firebase's own default is one.

Model calls are the one real cost, and they are the researcher's to watch: a
full micro-narrative journey is roughly 1–3p on `gpt-4o` at this protocol's
sizes. A hundred participants is a few pounds; the daily per-caller ceiling is
what stops a loop turning that into a surprise.

**Blaze plan is required** for Cloud Functions and scheduled exports — a card on
file, billed £0 in practice. Put a **£5 budget alert** on it. Without Blaze you
lose the nightly export and the linkage functions, and identity separation
becomes impossible to enforce, so Blaze is not really optional for this design.

---

## 7. What is still on the rented-box stack

`apps/api` and `infra/docker-compose.yml` remain in the repository, tested and
working. They are the fallback if Firebase ever becomes unsuitable — and because
the record is raw event logs derived by shared code, moving between them is
"read every session document, write it to Postgres" rather than a redesign.
