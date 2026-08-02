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

## Development

```sh
pnpm install
pnpm -r build && pnpm -r test   # 65 tests across schema/engine/library/scoring/release/app
cd apps/participant && pnpm dev # local participant app
```

Monorepo layout: `packages/schema` (definition layer), `packages/engine` (pure survey runtime), `packages/library` (YBM instruments + modules), `packages/scoring`, `packages/release` (manifest builder + publish gate), `apps/participant` (MySelf Go PWA).