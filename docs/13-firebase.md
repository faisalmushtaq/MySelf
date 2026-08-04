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
studies/{study}/
  sessions/{sessionId}          one document per sitting, whole event log inside
    chunks/{0000…}              only when a log is too big to fit — rare
  quarantine/{id}               sittings that arrived twice from different iPads
  corrections/{id}              mistyped-code repairs
  assignments/{sessionId}       twin splits
  devices/{deviceId}            enrolled iPads
  audit/{id}                    who did what
```

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
   slashes, so the console renders them as real folders.
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

Then make yourself an owner once, from a machine with admin credentials:

```bash
node -e "require('firebase-admin').initializeApp();require('firebase-admin').auth().getUserByEmail('you@leeds.ac.uk').then(u=>require('firebase-admin').auth().setCustomUserClaims(u.uid,{role:'owner'}))"
```

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

### 5.2 Pointing the pages at it

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

**It is metered.** Every call is counted per caller per day (600 by default,
`MYSELF_RELAY_DAILY_LIMIT`), and every call writes a provenance row server-side
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
