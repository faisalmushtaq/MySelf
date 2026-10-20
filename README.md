# MySelf

Research platform for self-report surveys and LLM-supported micro-narrative research.

- **Design package & source audits:** [docs/00-README.md](docs/00-README.md)
- **Decision register:** [migration/decisions.yaml](migration/decisions.yaml)
- **First frozen release:** [releases/ybm_nd2026_standard_r1.0.0.manifest.json](releases/)

## Participant app preview (GitHub Pages)

The participant PWA deploys automatically via the `pages.yml` workflow.
**One-time setup:** in this repository go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. After the next push the preview will be live at:

> https://faisalmushtaq.github.io/MySelf/

Open it on an iPad in Safari, then Share → *Add to Home Screen* to install it; it works fully offline after first load. Preview sessions are stored encrypted on the device only — no data leaves it.

## Fielding a study

**[docs/15-fielding-runbook.md](docs/15-fielding-runbook.md)** — what happens on
the day, handover, and getting the data out. Written to be followed on the
morning. There is nothing to set up per iPad: open the URL, add it to the Home
Screen, and it collects and files sittings by itself.

**[docs/14-readiness-audit.md](docs/14-readiness-audit.md)** — what is ready,
what is not, and what is deliberately left undone. Read §8 first.

## Development

New to the code? **[docs/17-maintainers-guide.md](docs/17-maintainers-guide.md)** —
what is where, how a question becomes data, and how to change a question, cut a
release, run each test suite and deploy.

```sh
pnpm install
pnpm -r build && pnpm -r test   # unit tests across the packages and apps
pnpm test:e2e                   # browser: the questionnaire, offline, resumed, and the
                                #   dataset cross-referenced against what was tapped
pnpm --filter @myself/functions test:integration   # the write path, real Firestore
pnpm test:e2e:sync              # the whole chain: browser → HTTP → real Firestore
cd apps/participant && pnpm dev # local participant app
```

The two emulator suites need Java 17 and download the Firestore emulator on first run.
`test:e2e` needs neither and stays offline.

`pnpm test:e2e` builds the participant app and drives it in a real browser. On a
machine whose browsers were installed elsewhere and where `playwright install` is
not allowed, point it at the binary:
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm test:e2e --project=chromium`.

Monorepo layout: `packages/schema` (definition layer), `packages/engine` (pure survey runtime), `packages/library` (YBM instruments + modules), `packages/scoring`, `packages/store` (dataset, BIDS export, handover encryption), `packages/firebase` (Firestore layout and the no-overwrite rule), `packages/release` (manifest builder + publish gate), `apps/participant` (MySelf Go PWA), `apps/researcher` (researcher view), `apps/functions` (the backend).

`apps/api` is a self-hosted Postgres alternative to `apps/functions`. Nothing
deployed calls it — Firebase is the backend (docs/14 §8).
## Public repository

This repository is public. It holds the survey's code and wording, never
participant data: answers live only in the Firebase project, behind its
security rules, and tests use made-up people. Secrets live in GitHub Actions
secrets, never in the code. Actions run logs are public too, so workflows mask
any email address they are given.

The standardised questionnaires in `packages/library` and `releases/` (for
example the SDQ, RCADS, SWEMWBS, STAI, BIS/BAS, the Edinburgh Handedness
Inventory and the MacArthur ladders) remain the property of their authors and
licence holders. They are reproduced here as administered in this study; check
each one's licence (recorded with it in `packages/library/src/instruments.ts`)
before reusing it.
