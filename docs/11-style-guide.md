# MySelf — Visual and Interaction Style Guide

Binding for every MySelf surface: the participant app (MyThoughts, MyStory), MySelf Studio, exported documents and any future interface. Decision **D-17**.

The visual language is inherited from the **BrainPop lab website** (`faisalmushtaq/brainpop-lab-website`) so MySelf reads as part of the lab's family, not as generic product UI. The *interaction* model follows the conversational-survey lineage popularised by Typeform: one question per screen, lettered option keys, keyboard parity, quiet chrome. Neither is copied wholesale — the lab's editorial restraint governs how the interaction patterns are dressed.

## 1. Tokens (single source of truth: `apps/participant/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--cream` | `#FAF6F0` | Page canvas everywhere. Never pure white backgrounds. |
| `--off-white` | `#F0EBE3` | Alternate blocks, image wells |
| `--paper` | `#FFFFFF` | Cards, inputs, raised surfaces only |
| `--text` | `#111110` | Primary text, primary buttons |
| `--text-muted` | `rgba(17,17,16,0.55)` | Body prose, labels, secondary chrome |
| `--hairline` | `rgba(17,17,16,0.12)` | Default borders |
| `--hairline-strong` | `rgba(17,17,16,0.28)` | Hover borders, input underlines |
| `--accent` | `#067843` | Selection, progress, affirmative state, MyStory/MyThoughts marks |
| `--accent-wash` | `rgba(6,120,67,0.08)` | Selected card fill |
| `--warn` | `#A33B00` | Errors, offline state (never red-on-green semantics alone) |
| `--radius` | `6px` | Cards and inputs. Pills (`999px`) only for buttons and chips. |

**Colour is never the sole carrier of meaning**: selection also shows a tick and a filled letter key; offline also states "Offline" in words.

## 2. Typography

- **Display — `Newsreader` (serif, weight 400):** question stems, brand wordmark, numbers in ladders/sliders, headings. Never bold; weight comes from size.
- **Body/UI — `DM Sans` (300/400/500):** option labels, prose, buttons, labels, status chrome. 300 for prose, 400 for controls, 500 only for buttons and uppercase labels.
- Fonts are **bundled via `@fontsource`**, never loaded from a CDN — the app must render identically offline in a school hall.
- Question stems: `clamp(1.6rem, 4.4vw, 2.15rem)`, measure capped at `30ch`. Stems longer than 110 characters step down to `1.55rem` at `46ch` (`.stem-long`) so an explanatory question reads as a paragraph.
- Micro-labels (`.field-label`, status strip): `0.72rem`, uppercase, `0.1em` tracking, muted — the lab site's editorial eyebrow.

## 3. Interaction patterns

- **One question per screen.** Grouping only where a validated instrument's administration requires it.
- **Lettered option keys (A, B, C…).** Shown as a bordered key on every choice card, and typing that letter selects it. The key fills with accent when selected. Beyond 26 options the keys are omitted rather than invented.
- **Enter advances.** The primary action shows a `↵` glyph on pointer devices, hidden on touch-only.
- **Auto-advance** on single-choice after ~300 ms, suppressed under `prefers-reduced-motion`.
- **Progress is segmented hairlines**, one per reachable section — never a percentage where branching makes remaining length uncertain.
- **Motion is minimal**: 0.15–0.2 s colour/border transitions, a 1 px card lift on hover. No page transitions, no parallax, no confetti.
- **Vertically centred question block** with the action pinned bottom-right; falls back to top-aligned under 620 px height.

## 4. Components

- **Cards** (`.card`): white on cream, hairline border, ≥56 px tall, letter key + label + tick. Selected = accent border, accent wash, filled key.
- **Text inputs**: underline-only in display serif for short answers (feels like writing on paper, not filling a form); bordered paper block for long-form narrative.
- **Primary button**: near-black pill, white text. **Start/finish** use the accent pill. **Decline** is an underlined muted link — always available where the protocol permits, never disguised.
- **Ladder** (MacArthur): stacked rungs, highest at top, accent fill on selection.
- **Chips + ranked list**: pill chips for membership, numbered list with 44 px reorder buttons — the accessible two-step alternative to drag.

## 5. Accessibility (non-negotiable)

44 px minimum touch targets · visible `2px` accent focus ring with offset · full keyboard path including the letter keys · every control labelled from the definition layer, not visual order · WCAG 2.2 AA contrast (accent `#067843` on cream passes for text ≥16 px and for UI borders) · `prefers-reduced-motion` honoured · text scales to 200 % without loss · no colour-only meaning.

## 6. Applying this to new surfaces

MySelf Studio (researcher) uses the same tokens and fonts with a denser scale: `0.95rem` body, tables on `--paper` with hairline rules, the same accent for state. It may add data-dense components (tables, charts) but must not introduce a second colour system, a second type family, or heavier motion. Charts use the accent plus neutral greys; additional categorical colours must be drawn from the lab site's category accents (`#067843`, `#1e6091`, `#964f8c`).
