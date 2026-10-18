# Deploying without GitHub Actions

Everything in MySelf deploys through GitHub Actions (`firebase.yml`, `pages.yml`), and Actions on a private repository draws on a monthly allowance of minutes. When the allowance is spent and the spending limit is $0, GitHub refuses to start jobs. Each one fails within seconds with a message that "the job was not started because recent account payments have failed or your spending limit needs to be increased", and nothing deploys until the allowance resets on the first of the month or the limit is raised.

The study itself is unaffected. The published survey, the Firebase functions and the database keep serving participants. What stops is shipping changes, and the one change that cannot wait is a fix to security rules or to a function. This page is how to ship those by hand.

**The quickest fix is usually to raise the limit.** GitHub, Settings, Billing and licensing, Budgets: set the Actions budget above $0. Jobs start again within minutes, sometimes after a short delay. Use this page when that is not possible or the change cannot wait for it.

## 1. What you need on the machine

Node 22, pnpm 10 and `firebase-tools@15` (`npm i -g firebase-tools@15`). Java 17 is needed only to test rules before deploying them. Sign in as an owner of the `myself-research` Firebase project with `firebase login`, or point `GOOGLE_APPLICATION_CREDENTIALS` at a service account key for that project, which is what the workflow does. Never commit a key.

From the repository root, on `main` at the commit you mean to deploy:

    git checkout main && git pull
    pnpm install --frozen-lockfile
    pnpm -r build
    pnpm -r test

The workflow runs the same three steps first, and a deploy that fails its tests should not go ahead by hand either.

## 2. Work out what to deploy

The workflow decides from the last commit alone. By hand, decide from everything since the last successful deploy, because during an outage several merges may have gone unshipped. In GitHub, Actions, "Deploy to Firebase", find the last green run and note its commit. Call it `LAST`. Then:

    git diff --name-only LAST HEAD | grep -E '^(apps/functions/|packages/(llm|narrative|firebase|schema|store|engine|scoring|release|library|studio)/|releases/|infra/firebase/(firebase\.json|firestore\.rules|storage\.rules))'
    git diff --name-only LAST HEAD | grep -E '^infra/firebase/(firestore\.rules|firestore\.indexes\.json|storage\.rules)'

Any output from the first command means the functions need deploying. Any output from the second means the rules do. Hosting goes every time.

## 3. Deploy

All of these run from `infra/firebase`.

**Hosting**, always:

    firebase deploy --only hosting --project myself-research --non-interactive

**Rules**, if they changed. Test them first against the emulator, because a rules file that fails its own suite should never reach the project. Then Firestore and Storage in turn:

    (cd test && npm install && npm test)
    firebase deploy --only firestore:rules,firestore:indexes --project myself-research --non-interactive
    firebase deploy --only storage --project myself-research --non-interactive

**Functions**, if they changed. Read this one before running it. The relay spending limits are held in GitHub repository variables (Settings, Secrets and variables, Actions, Variables), and the workflow passes them to the deploy. Run by hand without them, the functions deploy with the defaults in `apps/functions/src/relay-policy.ts`, which silently resets any limit you had changed, including a device limit of 0 used to switch MyStory calls off. Copy the three values across first. Leave a variable unset only if it is unset in GitHub:

    export MYSELF_RELAY_DAILY_LIMIT=...
    export MYSELF_RELAY_DEVICE_DAILY_LIMIT=...
    export MYSELF_RELAY_DEVICES_DAILY_LIMIT=...
    firebase deploy --only functions --project myself-research --non-interactive --force

`--force` is there for the reason given in `firebase.yml`: a function deleted from source otherwise aborts the whole deploy, and a function removed from `apps/functions` is deleted in the project by it. That is right for a deliberate removal and worth a glance at the diff for an accidental one.

Deploy rules before functions, as the workflow does, so that anything a new function reads or writes is already permitted when it starts serving.

## 4. Check it landed

Hosting serves the MyStory lab. Open https://myself-research.web.app and confirm its build stamp shows the commit you deployed. `firebase functions:list --project myself-research` shows the deployed functions. For a rules change, the Firebase console, Firestore, Rules tab shows the published time.

## 5. What has no manual route

The participant app on GitHub Pages (`pages.yml`) and the survey preview channel (`preview.yml`) are published by Actions alone. They wait for the allowance to return or the limit to be raised. The Survey archive (`survey-archive.yml`) also runs only in Actions. It archives every version that is new since its last run, so after an outage run it once by hand from the Actions tab and then check the `survey-archive` branch for any published version that is missing.

## 6. Keeping it from happening again

`ci.yml` is built to spend few minutes: pull requests run a fast tier of about 12 minutes, the browser suites run on `main`, which is what the deploys wait for, and a pull request gets them early by carrying the `full-ci` label. Draft pull requests run nothing. If usage still climbs, GitHub, Settings, Billing and licensing, Usage, filtered to Actions and grouped by repository, shows where the minutes went.
