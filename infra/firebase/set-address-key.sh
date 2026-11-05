#!/usr/bin/env bash
# One-off: stores the Ideal Postcodes API key the address finder uses (D-81)
# in Secret Manager, and lets the functions read it. Nothing goes into the
# repository or GitHub. Run again to replace the key.
#
#   bash infra/firebase/set-address-key.sh [project-id] [secret-name]
#
# Run in Cloud Shell (https://shell.cloud.google.com), signed in as an owner of
# the project. The key is on the Ideal Postcodes dashboard, under API keys; it
# starts "ak_". The finder picks it up within about ten minutes; no deploy is
# needed. Until a key is stored, the address screen uses the street list only.
set -euo pipefail
PROJECT="${1:-myself-research}"; SECRET="${2:-ideal-postcodes-key}"
ok() { printf '  ✓ %s\n' "$*"; }

gcloud services enable secretmanager.googleapis.com --project="$PROJECT" >/dev/null
read -r -s -p "Paste the Ideal Postcodes API key (nothing is shown as you type): " KEY; echo
KEY="${KEY// /}"
[[ "$KEY" == ak_* && ${#KEY} -ge 10 ]] || { echo "That does not look like an Ideal Postcodes key (they start ak_)."; exit 1; }

if gcloud secrets describe "$SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET" --project="$PROJECT" --data-file=- >/dev/null
  ok "new version of $SECRET stored"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET" --project="$PROJECT" \
    --replication-policy=user-managed --locations=europe-west2 --data-file=- >/dev/null
  ok "$SECRET created in europe-west2"
fi

# The functions run as the project's default compute service account.
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding "$SECRET" --project="$PROJECT" \
  --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor >/dev/null
ok "the functions may read it"
echo "Done. The address finder starts using the key within about ten minutes."
