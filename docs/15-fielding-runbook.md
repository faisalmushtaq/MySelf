# MySelf — fielding a survey on several iPads

Written to be followed on the morning, not read in advance. It covers the
survey, and MyStory where the version being fielded includes it: its daily
limits, and how to switch it off, are in §10 (D-55). Participant links, moving
an iPad to another survey, and study spaces are in §11 (D-56).

---

## 0. What the parts are

| Part | Where it runs | What it does |
|---|---|---|
| **MySelf Go** (participant app) | iPad, added to the Home Screen | Runs the questionnaire offline. Stores every answer encrypted on the device. Needs no setting up beyond the URL. |
| **`saveSitting`** | Cloud Function, europe-west2 | The only write path into the study. Idempotent, and refuses anything that contradicts a copy it already holds. |
| **Firestore** | `myself-research`, europe-west2 | One document per sitting, plus chunks for an unusually long one. |
| **Researcher view** | A laptop browser | Pulls sittings, derives the dataset, exports BIDS, and can stop a device. |
| **MyStory** | Inside the survey, on the iPad | The conversation, when the version includes it. Its model calls go through **`llmRelay`**, which holds the key, under daily limits (§10). |

A device never reads the study back. A person never writes a sitting. A device's
model calls, for MyStory, are capped per iPad and across the study each day. All
three are enforced server-side, not by the apps.

---

## 1. Once per study

**a. Give yourself a role.** Sign in to the researcher view once so the account
exists, then from a machine with the service-account key:

```sh
cd apps/functions
node grant-role.mjs you@leeds.ac.uk owner --project myself-research --key-file sa.json
```

This is the bootstrap and only the bootstrap: a fresh project has no owner, so
the first one cannot be granted through a permission check nobody can yet pass.
Every account after that is administered from the researcher view.

Signing in is not a permission. An account with no role sees an empty study, and
the view says so rather than looking broken.

**b. Choose the study passphrase.** One phrase for the whole study, at least 12
characters, real words rather than punctuation — it gets typed on an iPad
keyboard. It does two jobs:

- encrypts handover files written by an iPad that had no network;
- encrypts the names, dates of birth, UPNs and NHS numbers the researcher view
  holds.

Keep it where the study keeps its other credentials. It is never stored on any
device or laptop, so **losing it costs** any hand-entered UPN, NHS number or
relationship — names themselves are re-derived from the sittings.

---

## 2. Once per iPad — nothing to register

Open `https://faisalmushtaq.github.io/MySelf/` in Safari, then **Share → Add to
Home Screen**. Launch it from the Home Screen icon from now on. That is the whole
setup, and it needs no network beyond loading the page once.

**The Home Screen step is not cosmetic and it is the one thing here that can lose
data.** Safari deletes a website's saved data — the whole encrypted database of
sittings, and the offline app itself — after seven days of Safari being used
without that site being opened. It is not a storage warning and there is nothing to
recover afterwards: an iPad that collected on Monday, went into a cupboard, and is
picked up the following week is a blank device. An iOS web app launched from the
Home Screen is not subject to that cap, which is why this is step one.

The app checks for itself and says so. If it is running as a plain Safari tab, the
start screen carries a line asking for the Home Screen, and the handover panel
repeats it with the seven days named. Both disappear once the device is safe, so a
device showing neither is a device you can trust with held data. Two situations to
take seriously:

- **A line on the start screen asking for the Home Screen.** Do it before that
  iPad is used for real sittings. If it already holds sittings, sync it first.
- **"It has been holding data the study has not confirmed for N days."** Get that
  device on a network today. Three days is when this appears; seven is when Safari
  would delete it.

The iPad gives itself an identity on first launch: an id to be known by and a
secret to prove it, both generated on the device, **before it has ever reached the
study**. The first upload registers that secret, and from then on the study accepts
that id only from a device that can present the same one. First writer wins,
permanently — which is what makes "the same device" mean something a second device
cannot claim, and therefore what makes the no-overwrite rules hold.

You will see the id in the handover panel. It is also written into every handover
file, so a sitting that arrives by file and the same sitting arriving later over
wifi are recognised as one sitting from one device rather than two.

**There is no console switch to find and nothing to enable.** An earlier version
signed devices in anonymously, which needed both a project setting and a network
round trip before a device had any identity at all — and the device that most needs
an identity is the one in a hall with no signal.

**The trade:** the write endpoint is reachable by whoever has the URL. That is the
cost of a device being able to take part without being registered. Three things
bound it: every sitting records whether it came from an open device or a registered
one, so a stray one can be told apart in the dataset; an upload ceiling per device
stops a runaway client, which is the likely accident; and a specific device can be
stopped (§8). If the URL ever circulates further than intended, **App Check** is the
real control and is a project setting rather than a code change.

The same credential also lets MyStory make model calls (D-55), and those cost
money, so they have a daily limit per iPad and a ceiling across the whole study
(§10). The ceiling is what bounds a stranger who registers many devices.

**Adding a device mid-study needs no action at all.** Open the URL on it — and add
it to the Home Screen, for the reason above.

**Set the staff PIN before the iPad goes near a participant.** The first time the
handover panel is opened on an iPad (five taps on the build line), it asks you to
choose a staff PIN of 4 to 8 digits, typed twice. From then on the panel — and with
it the export, the survey switch and Clear — opens only with that PIN. Use the same
PIN on every iPad of a study and keep it with the study passphrase, not on the
device. Five wrong PINs lock the panel for five minutes. The PIN is kept only on
that iPad, as a salted hash; nobody, including the study, can read it back.

**A forgotten PIN can only be reset by clearing the site's data** (Settings →
Apps → Safari → Advanced → Website Data → remove the MySelf site, or delete the
Home Screen app). **That also deletes every sitting on the iPad that has not been
uploaded, permanently** — the encryption key goes with it. So before resetting:
get the iPad onto a working network and let it upload (the start screen's small
print counts what is awaiting sync, no PIN needed) until it reads **0 sessions
awaiting sync** and no participant is part-way through. Only then clear it, and set
a new PIN on first opening.

## 3. On the day

Hand the iPad over on the start screen. The participant types their code and
begins. Nothing else is required of the operator.

What is happening underneath:

- Every answer is written to encrypted storage on the device **before** the screen
  advances. If a write ever fails — an iPad out of space, or one whose database iOS
  has evicted — **the survey stops** and asks the participant to put their hand up.
  It does not carry on, because a sitting with gaps nobody knows about is worse than
  a sitting that stopped. Free some space and tap Try again, or hand over what is on
  the device and use another iPad.
- Every two minutes, a copy of the sitting **so far** goes to the study, so a
  dropped iPad or a flat battery costs at most the answers since the last
  checkpoint rather than the whole morning. The same tick also uploads any earlier
  participants' finished sittings, so a morning of back-to-back handovers does not
  hold them all until the end.
- A finished sitting is queued, sent, and marked confirmed only once the study has
  reported back that it stored **every event the device sent**. A 200 is not an
  answer; the event count is.
- With no network, all of it still works and the queue drains when a network
  returns. **Wifi coming back is acted on immediately** rather than waited out — the
  device drops whatever retry delay it had chosen and tries at once.

### Sharing an iPad between participants

The app assumes the next person to pick an iPad up may be another child, and
behaves accordingly:

- **Carrying on an unfinished sitting needs the date of birth.** A participant who
  types the code of a sitting that stopped part-way is asked *"To carry on, enter
  your date of birth"*, and is put back where they stopped only if it matches the
  date given in that sitting. Three wrong dates and that code cannot be carried on
  on this iPad: the child sees *"Please ask a member of the research team"*. Check
  who they are, then in the handover panel tap **Allow** *(the code)* **to carry on**, which
  gives three more tries. The sitting itself is never touched and still uploads.
- **A sitting that stopped before the date of birth was given is not reopened.**
  If it stopped on the welcome or consent screens with nothing answered, the code
  carries on as before. If it holds answers but no date of birth (in YBM, stopped
  between the name and the date of birth), the code starts a new sitting; the
  unfinished one stays on the iPad and uploads as a partial sitting. Expect the
  occasional extra partial sitting in the dataset for that reason.
- **Screens go back to the start by themselves.** The finish screen and *Go back
  to my answers* return to the start after two minutes untouched, with a
  20-second countdown and an **I'm still here** button. A question in the middle of
  a sitting asks *"Are you still there?"* after ten minutes untouched and returns to
  the start 60 seconds later; the sitting is kept and can be carried on with the
  code and date of birth. An open handover panel closes after two minutes
  untouched, and always closes (forgetting the passphrase typed into it) when a
  participant presses Start. None of this happens while the *Let's pause a moment*
  save-failed screen is up: that waits for a person.
- **MyStory conversations:** the module runs in its own frame, and typing there is
  not seen by the app, so a long conversation can meet *"Are you still there?"*
  after ten minutes; one tap carries on.
- **The start screen never shows a real code**, so do not tell a participant
  "it's like the example" — give them their own.

**A new build never interrupts a sitting.** If one arrives mid-morning it waits for
the start screen, between participants.

**A new survey version needs no new build.** Versions published in MySelf Studio
(docs/16) are picked up at the start screen, in the background, and only for the
next participant; anyone mid-way through finishes on the version they started.
The small print under the start screen names the release in use and whether it
was downloaded or is the one built in. Offline, the iPad keeps using the last
version it downloaded — so open MySelf once on wifi after a publish, before a
session somewhere without it.

**Once only, when the Studio build first ships:** an iPad already running
MySelf picks the new build up only after the app is fully closed (swiped away)
and opened again. Do that once per iPad, at the start screen.

### What a bad network looks like from the iPad

| What happens | What the device does |
|---|---|
| No signal at all | Collects normally. Nothing is attempted, nothing is lost. |
| Saturated access point, requests hang | Gives up on each after 30 seconds and retries later. |
| Guest network with a **captive portal** | Refuses the portal's reply rather than mistaking a login page for a successful upload, and says the network may need signing in to. |
| Connection drops mid-response | Treats it as a failure and re-sends. The study's write path is idempotent, so a sitting that did land is not duplicated. |
| Repeated failures | Backs off, thirty seconds doubling to a ten-minute ceiling, jittered so a rack of iPads that failed together does not retry together. |
| **Days go by with no network at all** | Collects and holds indefinitely, and after three days says on the handover panel how long it has been holding. This is the one case with a deadline that is not the device's: Safari deletes a plain tab's data at seven days (§2). A Home Screen app has no deadline. |

The one thing the device will never do is mark a sitting confirmed on anything less
than the study saying it stored every event.

## 4. End of the day

On each iPad, open the handover panel (five taps on the build line, then the
staff PIN — §2). It reads,
in plain numbers, how many sittings are awaiting upload, confirmed by the study,
needing review, and unfinished.

**If the numbers say everything is confirmed:** tap **Clear N confirmed
sittings**. This cannot touch a sitting the study has not confirmed — it checks
the stored receipt against what is on the device — so there is no wrong way to
press it.

**If some are still awaiting upload:** tap **Sync completed sessions** on a
working network. If there is no usable network at all:

1. Type the study passphrase into the handover panel.
2. Tap **Export completed sessions**. You get one encrypted file.
3. Put the file in approved storage and check it opens in the researcher view.
4. **Leave the sittings on the device** until you have. Exporting deletes
   nothing, deliberately.

Never clear Safari's data or delete the app to tidy an iPad up. That destroys
the device's encryption key along with it, and anything not yet handed over
becomes permanently unreadable.

---

## 5. Getting the data

In the researcher view, **Data → Pull sittings from the study**. Safe to repeat:
a sitting already held is left alone unless the study has a longer copy of it,
which is what happens when a device uploaded one mid-sitting and finished later.

The report tells you four things, and the last two matter:

- how many are new, superseded, or already current;
- **held for review** — the study has two copies of a sitting that contradict
  each other and will not choose between them. Go and look (§6).
- **could not reassemble** — a spilled sitting is missing a chunk. The device may
  still hold it; re-sync that device.

For a file instead, type the study passphrase first, then drop the file in.

Names are locked. The overview, the table and the BIDS export all work without
the passphrase, because sittings carry codes and no names. Only the **Linkage**
tab asks for it, and it re-locks itself after fifteen minutes hidden.

---

## 6. When a sitting is held for review

The study refuses to overwrite a stored sitting with one that contradicts it. It
keeps both and flags it. Four reasons, in
`studies/ybm/quarantine`, each row naming both event counts:

| Reason | What it usually means |
|---|---|
| received from a second device | A session id collided, or an iPad was restored from a backup. |
| release hash differs | The two copies were collected under different versions of the questionnaire. |
| the stored copy is finished, this one is in progress | A stale checkpoint arrived after the real sitting. Usually harmless. |
| a sitting never gets shorter | A device sent fewer events than the study holds. The longer copy is kept. |

Only the first two also flag the stored copy, because only those two leave
genuine doubt about which copy is real. The other two keep the good copy in the
dataset.

A quarantined sitting is excluded from the dataset and from the export until a
person clears it.

---

## 7. Withdrawal

Handled manually, by arrangement, outside this platform. There is no delete path
in the code — see docs/14 §2.1. The consent form promises removal within 24
hours of submission, so whoever fields the study has to be able to honour that
by hand and record that they did.

From survey version 8.0.0 there is no secret code to quote (D-52): someone asking
to withdraw gives their name and date of birth. The **Linkage** tab finds their
sittings by name; the participant ID is also recomputable from name and date of
birth (docs/06, D-52), and their address confirms it is the right person.

**Linkage with Connected Yorkshire (from 9.0.0, D-53).** Each sitting records
whether the participant agreed to their answers being linked with health and
education records (`linkage_consent`: 1 = yes, 2 = no). Only people whose
most recent answer is yes may be sent for linkage; a sitting with no answer is
treated as no. Someone who emails to stop linkage is withdrawn from linkage
only, not from the study, unless they also ask for that. Record the date they
asked, stop including them in any further linkage, and tell Connected Yorkshire
by the route the data-sharing agreement sets out.

---

## 8. Stopping one device

A device filing something it should not — a stray iPad, an obvious test run from
outside the room — is dealt with by taking its identity away. Its device id is on
every sitting in the table. Paste it into **Data → Stop a device** (owners only).
It cannot post again, and its MyStory calls stop too. Nothing it already filed
is removed, because deciding what to do with that is a judgement rather than a
button.

---

## 9. If something looks wrong

| Symptom | Where to look |
|---|---|
| "Let's pause a moment" on the participant's screen | The iPad could not save an answer — usually out of space. Free some and tap Try again, or hand over and swap devices. The survey has deliberately stopped. |
| "this network may need signing in to" | A captive portal answered instead of the study. Sign the device in to the wifi, or hand over by file. |
| "another device is already registered under this installation id" | Two devices have the same installation id — a restored backup, almost always. Hand that device's sittings over as a file; they are not lost. |
| Sittings stay *awaiting upload* on a good network | Check the device was not revoked, and that the build was deployed with a project configured. A build with none says so in the handover panel. |
| "you are signed in, but this account has no role" | §1a. An owner grants a role. |
| The researcher view shows an empty study | Either no role (§1a), or nothing has been pulled yet. |
| Linkage shows no names | The vault is locked, or was unlocked after the last derive — unlocking triggers one. |
| A name looks like nonsense | Wrong passphrase. It should have been refused; report it. |
| A sitting is dated to the wrong day | That iPad's clock was wrong. Every upload records what the device believed the time was alongside when the study received it, so the offset is in the audit trail (`sittings.received` rows carry `sentAt`, the study's `receivedAt` for the same moment, and the `clockSkewMs` between them), and a device more than five minutes out is logged as a warning. Response *timings* are unaffected — those come from a monotonic clock and never from the wall clock. Correct the iPad's date and report the offset so the affected sittings can be adjusted. |
| A device has been holding data for days | Get it on a network today. See §2: a Safari tab loses everything at seven days. |
| "This device has used MyStory as much as it can for today" | That iPad reached its own daily limit (§10). The participant carries on without MyStory. If an iPad will carry more conversations than that in a day, raise the limit. |
| "MyStory has had as many conversations as it can for today" | The whole study reached its daily ceiling (§10). Check the counts: more than a day's fielding is a reason to look for a stranger, not to raise the ceiling. |
| "MyStory is switched off at the moment" | A limit is set to `0` (§10), on purpose or by a typo in the setting. |

---

## 10. MyStory: its daily limits, and switching it off

From D-55 (docs/09 §5) any participant's iPad may use the model for MyStory,
with nobody signed in. Model calls cost money and anyone with the URL can make
a new installation, so two limits apply to iPads. They do not apply to
researchers or tester links.

| Limit | Repository variable | Default |
|---|---|---|
| Model calls **one iPad** may make in a day | `MYSELF_RELAY_DEVICE_DAILY_LIMIT` | 120 |
| Model calls **all iPads together** may make in a day | `MYSELF_RELAY_DEVICES_DAILY_LIMIT` | 2,000 |

- A **day** is a UTC day: it turns over at midnight GMT, 1am in summer.
- A **transcription** (a spoken answer) counts as one call.
- **What one conversation takes.** A typical one is 12–15 calls; the longest,
  every answer spoken and the story revised twice, about 40. So 120 is eight to
  ten typical conversations per iPad per day. **An iPad shared by more children
  than that in a day needs more:** about 15 a conversation, so 300 for twenty
  children.
- **What a participant sees** when a limit is reached: MyStory says so in plain
  words, and the survey offers "Skip this part" (or "Finish without it") at
  once. Nothing already answered is affected.
- **The counts** are in the Firestore console, `studies/ybm/audit_relayDevices`:
  `{YYYY-MM-DD}` for the whole study and `{YYYY-MM-DD}_{installId}` for one
  iPad. Each has `calls` (let through) and `refused`.

**To change a limit.** In GitHub: **Settings → Secrets and variables → Actions →
Variables**, add or edit the variable. Then **Actions → Deploy to Firebase →
Run workflow**, with **Deploy the functions as well** ticked. The packaging step
writes the variable into the functions' environment. From a laptop, set the
variable in the shell instead, for example
`MYSELF_RELAY_DEVICE_DAILY_LIMIT=300 firebase deploy --only functions --project myself-research`
from `infra/firebase`. An empty or missing variable means the default.

**To switch MyStory's model calls off for every iPad,** set either variable to
`0` and deploy as above. Every iPad's call is then refused with "MyStory is
switched off at the moment"; researchers and tester links are unaffected.
Anything that is not a whole number of zero or more also reads as `0`, so a typo
switches it off rather than removing the limit.

- **In a hurry**, the same variable can be set on the running functions without
  a deploy: Google Cloud console → **Cloud Run** → `llmrelay`, then
  `transcribe` → **Edit and deploy new revision** → **Variables and secrets**.
  Set the repository variable as well: the next functions deploy sets the
  environment from it.
- **One iPad** misbehaving: stop it (§8). That stops its calls too.
- **Everything at once**, researchers included: revoke the OpenAI key.

**Before fielding: a budget limit on the OpenAI project.** The ceiling bounds
how many calls iPads make in a day, not how large each one is. A typical full
day is a few pounds, but a stranger crafting oversized calls could make the
worst day cost hundreds. Set a monthly budget limit and alerts on the OpenAI
project; that is the last line, and it is the provider's, not this platform's.

## 11. Participant links and study spaces (D-56)

From D-56 (docs/09 §5, docs/16 §11) one project runs several studies and
surveys. A **study space** (`ybm` is one) has its own surveys, its own Studio
access list and its own data. Each Studio survey with a live version has a
**participant link**:

```
https://faisalmushtaq.github.io/MySelf/?study=<study>&survey=<survey>
```

It is in the Studio, on the survey's row in the list and on its **Versions**
page (**Participant link**), with a copy button and a QR code to print.

**Setting an iPad to a survey.**

1. On wifi, open the participant link on the iPad, or scan its QR code.
2. The iPad checks the survey is live, downloads it and keeps it. The small
   print under the start screen then says `survey <study>/<survey>`. From then
   on new sittings use that survey, offline too, and pick up each new version
   at the start screen.
3. **An iPad that runs MySelf from the Home Screen** keeps its own storage,
   apart from Safari's. A link opened in Safari sets Safari's copy, not the
   app's. So either open the link in Safari and **Share → Add to Home Screen**
   from that page, or (simplest) open the app, open the handover panel (five
   taps on the build line), paste the link under **Survey on this iPad**, tap
   **Check**, then **Use this survey on this iPad**.

**What the iPad says, and what to do.**

| The start screen says | What to do |
|---|---|
| "…given a link to … It has to be downloaded once, and this iPad is offline" | Put it on wifi. It tries again by itself. Nothing can start until it has. |
| "The link to … can't be used: there is no such study / it has no live version / the study is closed" | Check the link; publish the survey in the Studio; or ask an owner to reopen the study. The iPad stays on what it was on. |
| "This iPad was set up from this link before and has been moved since" | It was moved in the handover panel after the link was used. Use the panel to move it again. |
| "This iPad is set to … which is not on this iPad yet" | Put it on wifi; or move it back to the default survey in the handover panel. |
| "This study is closed" | An unfinished sitting can be finished; a new code is refused. |

**Back to the default survey:** in the handover panel, **Back to the default
survey**, then **Use this survey on this iPad**. It works offline. The Studio's
link for the default survey does the same.

**Unfinished sittings stay where they started.** After a switch, a code starts
the new survey; a participant's unfinished sitting of the old one stays on the
iPad, keeps uploading its progress to its own study, and is finished once the
iPad is moved back. The panel says how many there are before you confirm.

**Uploads sort themselves.** Each sitting is filed into the study it started
in, whichever survey the iPad is on when it is sent. Handover files record each
sitting's study.

**Creating and closing a study space** (project owners only, in the Studio):
the study switcher in the header → **New study space…** (a title, and an id of
2 to 40 lower-case letters, numbers and underscores, which can never change).
You become its admin; add its team under **Who has access**. **This study
space's settings…** renames it or closes it. Closed: no new iPad can join, an
iPad that sees it is closed starts no new sitting, and MyStory makes no calls
for it; sittings from iPads it already knows are still accepted, and nothing is
deleted. Reopen it the same way.

**MyStory's limits are per study:** 120 calls per iPad per day in each study,
and the 2,000-call ceiling per study (§10). The counts are under
`studies/<study>/audit_relayDevices`.

**Data.** Each study's sittings are under `studies/<study>/sessions`; the
nightly export writes `exports/<date>/` for `ybm` as before and
`exports/studies/<study>/<date>/` for every other study with sittings.
