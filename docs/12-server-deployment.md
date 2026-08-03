# MySelf — standing up the server

Written to be followed, not read. Everything here runs on a host you own, with
no dependency on University of Leeds infrastructure or accounts (D-36).

---

## 1. What you are setting up

Four containers on one machine:

| Container | Job |
|---|---|
| **Postgres 16** | Stores raw device event logs. Two schemas, two roles: `research` (answers, keyed by participant code) and `identity` (names, if a study ever needs them). The API's role has **no grant** on `identity`. |
| **Keycloak** | Sign-in, and the admin console where you add people, give them a role, and remove them. This is the "who has admin rights" control. |
| **API** | Accepts sittings from iPads, hands them back to the researcher view, enforces roles, writes the audit log. |
| **Caddy** | TLS in front, certificates obtained and renewed automatically. |

The API stores nothing derived. Participants, waves, scores and the BIDS folder
are computed from the raw logs by `@myself/store` — the same code the browser
runs — so a screen and an export cannot disagree (D-35).

---

## 2. Choose a host

Any provider that will rent you a Linux box and take your card. What matters:

- **UK or EU region.** UK GDPR permits EEA hosting; both are straightforward to
  describe in a DPIA. A US-default platform is a fight you do not need.
- **Snapshots you control**, and a way to copy backups off the machine.
- **No lock-in.** Nothing in this stack needs a service only one company sells.

Sensible picks, cheapest first:

| Provider | Region | Spec | Cost |
|---|---|---|---|
| **Hetzner Cloud** (recommended) | Falkenstein / Helsinki (EU) | CX32: 4 vCPU, 8 GB, 80 GB | ~€8/month |
| **DigitalOcean** | London (LON1) | 4 GB droplet + managed Postgres | ~$24 + $15/month |
| **Scaleway / OVH** | Paris (EU) | comparable | ~€10–20/month |

One CX32 comfortably runs all four containers for a study of this size.
Storage is the thing to watch, not CPU: raw event logs are a few hundred
kilobytes per sitting, so 80 GB is years of fieldwork.

**Add a second, smaller thing:** object storage for backups (Hetzner Storage
Box ~€4/month, or Backblaze B2). Backups must not live on the machine they are
backing up.

---

## 3. First boot

```bash
# On the box, as root
apt update && apt install -y docker.io docker-compose-v2 git
adduser --disabled-password myself && usermod -aG docker myself

# As the myself user
git clone https://github.com/faisalmushtaq/MySelf.git /opt/myself
cd /opt/myself/infra
cp env.example .env
```

Fill in `.env`. Generate each secret with `openssl rand -base64 32` — do not
invent them by hand, and do not reuse one you have used elsewhere.

Point an **A record** for your domain at the box's IP, wait for it to resolve,
then:

```bash
docker compose up -d
docker compose logs -f caddy   # watch the certificate be issued
```

Check it is alive:

```bash
curl https://YOUR-DOMAIN/api/health
# {"ok":true,"at":"..."}
```

---

## 4. Set up sign-in and roles

This is the part you asked to control directly. It is all in the Keycloak
console at `https://YOUR-DOMAIN/auth/`.

1. Sign in with `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from `.env`.
2. **Create a realm** called `myself`.
3. **Create the three realm roles**, exactly these names:
   - `owner` — everything, including enrolling iPads, managing people, and the
     privileged read of identifiers
   - `researcher` — read, import, export, resolve quarantine
   - `analyst` — read only
4. **Create a client** called `myself`: public client, standard flow on, valid
   redirect URI set to the researcher view's URL, web origins the same.
5. **Create your own account**, assign it `owner`, set a password, **turn on
   OTP**. Then disable the bootstrap `admin` account from step 1.

After that, adding a colleague is: Users → Add user → set email → Role mapping
→ assign `researcher` or `analyst`. Removing them is Users → Delete, and their
next request fails. Nothing else in the system needs touching, and the API
never has its own user list to drift out of step.

**A person with an account and no role gets a clear refusal**, not an empty
study: *"your account has no role in this study — ask an owner to give you
one."* That is deliberate — silence looks like a bug and invites someone to go
looking for a workaround.

---

## 5. Enrol the iPads

Each iPad gets a token, once, from an owner:

```bash
curl -X POST https://YOUR-DOMAIN/api/devices \
  -H "authorization: Bearer $YOUR_ACCESS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"iPad 1 — Leeds","study":"ybm"}'
```

The response contains the token **once**. The server stored only its SHA-256
hash, so there is no endpoint that can show it to you again — copy it into the
iPad's settings there and then.

If an iPad is lost: `POST /api/devices/:deviceId/revoke`. The next sync from
that device is refused. The answers already on it stay encrypted at rest, which
is why the device passcode is part of the provisioning runbook (D-13).

---

## 6. Backups, and the drill

```bash
crontab -e
0 2 * * *  /opt/myself/infra/backup.sh >> /var/log/myself-backup.log 2>&1
```

`backup.sh` dumps the database, refuses to continue if the dump came out
suspiciously small, copies it off-site with `rclone`, and prunes local copies
after a month.

**Do the restore drill before the first fieldwork, and once a term after
that.** An untested backup is a hope:

```bash
# On a scratch machine, or a second stack on the same box
gunzip -c myself_20260901T020000Z.sql.gz | \
  docker compose exec -T db psql -U myself -d myself_restore_test
docker compose exec db psql -U myself -d myself_restore_test \
  -c "SELECT count(*) FROM research.sessions;"
```

Compare the count with production. If they differ, find out why *now*.

---

## 7. Keeping it alive

| Task | How often | What |
|---|---|---|
| OS security updates | automatic | `apt install unattended-upgrades` |
| Container images | monthly | `docker compose pull && docker compose up -d` |
| Restore drill | each term | §6 |
| Audit log review | each term | `GET /api/audit` — who exported what |
| Device list review | each term | `GET /api/devices` — revoke anything not in a cupboard |

This is roughly twenty minutes a term. It is the price of not having a
university IT department doing it for you, and it is the part that quietly
stops happening — put the dates in a calendar now, not later.

---

## 8. What this does not change

Hosting the server yourself changes who operates it. It does not change who is
responsible for the data.

- If the research is sponsored by the University of Leeds, **Leeds remains the
  data controller** whatever machine the answers sit on. The hosting provider
  becomes a data processor you have chosen, and needs naming in the DPIA along
  with its region and its terms.
- **PSCETHS-1449 describes a data flow that ends on the iPads.** Syncing to a
  server is a different flow — different location, different retention,
  different access list. That needs an amendment, and it is the item most
  likely to take weeks, so start it before the code is finished.
- Until that amendment is approved, **keep real fieldwork on the file route**.
  The handover export works today and is covered by the current approval. The
  server can be stood up, tested with synthetic data, and left waiting.

None of this is legal advice; it is the shape of the conversation to have with
the DPO and the ethics committee.

---

## 9. Running it locally first

No account needed, and worth doing before you rent anything:

```bash
cd infra
cp env.example .env       # DOMAIN=localhost is fine
docker compose up -d db
DATABASE_URL=postgres://myself:...@localhost:5432/myself \
  pnpm --filter @myself/api migrate
MYSELF_DEV_AUTH=1 OIDC_ISSUER=http://localhost/none DATABASE_URL=... \
  pnpm --filter @myself/api start
```

`MYSELF_DEV_AUTH=1` accepts `Authorization: Bearer dev:you:owner` so you can
exercise every endpoint without Keycloak running. It **refuses to start** when
`NODE_ENV=production` — an unauthenticated server holding children's answers is
not a mode worth having available by accident.
