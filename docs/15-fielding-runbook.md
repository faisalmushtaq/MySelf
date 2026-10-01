# MySelf — fielding a survey on several iPads

Written to be followed on the morning, not read in advance. It covers the
survey only: the micro-narrative module is not fielded (docs/14 §4).

---

## 0. What the parts are

| Part | Where it runs | What it does |
|---|---|---|
| **MySelf Go** (participant app) | iPad, added to the Home Screen | Runs the questionnaire offline. Stores every answer encrypted on the device. Needs no setting up beyond the URL. |
| **`saveSitting`** | Cloud Function, europe-west2 | The only write path into the study. Idempotent, and refuses anything that contradicts a copy it already holds. |
| **Firestore** | `myself-research`, europe-west2 | One document per sitting, plus chunks for an unusually long one. |
| **Researcher view** | A laptop browser | Pulls sittings, derives the dataset, exports BIDS, and can stop a device. |

A device never reads the study back. A person never writes a sitting. A device that
can file a sitting still cannot make a model call. All three are enforced
server-side, not by the apps.

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

**Adding a device mid-study needs no action at all.** Open the URL on it — and add
it to the Home Screen, for the reason above.

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

On each iPad, open the handover panel (five taps on the build line). It reads,
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
It cannot post again; nothing it already filed is removed, because deciding what
to do with that is a judgement rather than a button.

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
