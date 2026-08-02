# MySelf — Visual and Interaction Style Guide

Binding for every MySelf surface: the participant app (MyThoughts, MyStory), MySelf Studio, exported documents and any future interface. Decision **D-17**.

The visual language is inherited from the **BrainPop lab website** (`faisalmushtaq/brainpop-lab-website`) so MySelf reads as part of the lab's family, not as generic product UI — its typography and editorial restraint, set on a near-white canvas with all-black text (researcher direction, D-18). The *interaction* model follows the conversational-survey lineage: one question per screen, large readable type, quiet chrome. Neither is copied wholesale.

**Controls should look like what they measure.** Where an instrument has a visual metaphor, the picture *is* the control: the MacArthur ladder is a drawn ladder you tap or drag, hair type is a grid of drawn curl patterns you recognise. Illustrations are MySelf-authored inline SVG — they scale, work offline, and carry no third-party asset dependency.

## 1. Tokens (single source of truth: `apps/participant/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#FCFCFB` | Page canvas everywhere (near-white, a shade off pure white) |
| `--off-white` | `#F4F4F2` | Alternate blocks, image wells |
| `--paper` | `#FFFFFF` | Cards, inputs, raised surfaces only |
| `--text` | `#000000` | **All text is black.** Hierarchy comes from size and weight, never from greying text out. |
| `--hairline` | `rgba(0,0,0,0.14)` | Default borders |
| `--hairline-strong` | `rgba(0,0,0,0.34)` | Hover borders, input underlines |
| `--accent` | `#067843` | Selection, progress, affirmative state, MyStory/MyThoughts marks |
| `--accent-wash` | `rgba(6,120,67,0.08)` | Selected card fill |
| `--warn` | `#A33B00` | Errors, offline state (never red-on-green semantics alone) |
| `--radius` | `6px` | Cards and inputs. Pills (`999px`) only for buttons and chips. |

**Colour is never the sole carrier of meaning**: selection also shows a tick and a filled letter key; offline also states "Offline" in words.

## 2. Typography

- **Display — `Newsreader` (serif, weight 400):** question stems, brand wordmark, numbers in ladders/sliders, headings. Never bold; weight comes from size.
- **Body/UI — `DM Sans` (300/400/500):** option labels, prose, buttons, labels, status chrome. 300 for prose, 400 for controls, 500 only for buttons and uppercase labels.
- Fonts are **bundled via `@fontsource`**, never loaded from a CDN — the app must render identically offline in a school hall.
- **Base size is large by design**: 20px on phones, 22px from 768px up. Participants include children and low-literacy readers; small type is not an aesthetic choice we get to make.
- Question stems: `clamp(1.75rem, 5vw, 2.4rem)`, measure capped at `30ch`. Stems longer than 110 characters step down to `1.75rem` at `46ch` (`.stem-long`) so an explanatory question reads as a paragraph.
- Micro-labels (`.field-label`, status strip): `0.78rem`, uppercase, `0.08em` tracking — the lab site's editorial eyebrow.

## 3. Interaction patterns

- **One question per screen.** Grouping only where a validated instrument's administration requires it.
- **Options show only the options.** No letter keys, numbers or shortcut badges — nothing for a participant to decode. Selection is by tap, click, or Tab + Space.
- **Enter advances** for keyboard users, with no on-screen glyph to explain.
- **Auto-advance** on single-choice after ~300 ms, suppressed under `prefers-reduced-motion`.
- **Progress is segmented hairlines**, one per reachable section — never a percentage where branching makes remaining length uncertain.
- **Motion is minimal**: 0.15–0.2 s colour/border transitions, a 1 px card lift on hover. No page transitions, no parallax, no confetti.
- **Vertically centred question block** with the action pinned bottom-right; falls back to top-aligned under 620 px height.

## 4. Components

- **Cards** (`.card`): white on the canvas, hairline border, ≥56 px tall, label + tick. Selected = accent border and accent wash.
- **Illustrated tiles** (`.tile`): for options chosen by appearance. Each tile draws its pattern, shows the authoritative code (e.g. `2b`) and a plain-language gloss ("Defined waves"); the accessible name combines both.
- **Text inputs**: underline-only in display serif for short answers (feels like writing on paper, not filling a form); bordered paper block for long-form narrative.
- **Primary button**: near-black pill, white text. **Start/finish** use the accent pill. **Decline** is an underlined muted link — always available where the protocol permits, never disguised.
- **Ladder** (MacArthur): a drawn ladder — two rails, numbered rungs, highest at top — that responds to tap, drag and arrow keys, with researcher-authored anchor text at each end and a spoken-language confirmation ("You chose rung 8"). Exposed as `role=slider` with `aria-valuetext`.
- **Chips + ranked list**: pill chips for membership, numbered list with 44 px reorder buttons — the accessible two-step alternative to drag.

## 5. Accessibility (non-negotiable)

44 px minimum touch targets · visible `2px` accent focus ring with offset (pointer interaction never leaves a focus box) · full keyboard path · every control labelled from the definition layer, not visual order · WCAG 2.2 AA contrast (accent `#067843` on cream passes for text ≥16 px and for UI borders) · `prefers-reduced-motion` honoured · text scales to 200 % without loss · no colour-only meaning.

## 6. Applying this to new surfaces

MySelf Studio (researcher) uses the same tokens and fonts with a denser scale: `0.95rem` body, tables on `--paper` with hairline rules, the same accent for state. It may add data-dense components (tables, charts) but must not introduce a second colour system, a second type family, or heavier motion. Charts use the accent plus neutral greys; additional categorical colours must be drawn from the lab site's category accents (`#067843`, `#1e6091`, `#964f8c`).
