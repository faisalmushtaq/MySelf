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
| `--accent-wash` | `rgba(6,120,67,0.07)` | Selected card fill |
| `--warn` | `#A33B00` | Errors, offline state (never red-on-green semantics alone) |
| `--radius` | `6px` | Cards and inputs. Pills (`999px`) only for buttons and chips. |

**Colour is never the sole carrier of meaning**: selection also shows a tick or a filled highlight; offline also states "Offline" in words.

## 2. Typography

- **One typeface throughout (`Newsreader`)** — question stems, options, prose, buttons, ladder numbers and the wordmark all share it (D-21). Nothing on screen changes voice mid-question. The serif is the distinctive one and it is the one everything is set in (D-24) — the earlier sans/serif pairing, and the later decision to unify on the sans, are both superseded. Hierarchy comes from **size and weight only**: 400 for prose and controls, 500 for stems and emphasis, 600–700 for the wordmark and headings.
- **Single switch point for an accessible face.** `--font-ui` in `:root` is the only place the family is named; `--font-display` and `--font-body` both alias it. A dyslexia-friendly font (e.g. Atkinson Hyperlegible or OpenDyslexic via `@fontsource`) becomes a one-line change, or a body-class toggle for a per-participant setting — no component touches needed. Planned, not yet built.
- Fonts are **bundled via `@fontsource`**, never loaded from a CDN — the app must render identically offline in a school hall.
- **Base size is large by design**: 20px on phones, 22px from 768px up. Participants include children and low-literacy readers; small type is not an aesthetic choice we get to make.
- Question stems: `clamp(1.75rem, 5vw, 2.4rem)`, measure capped at `30ch`. Stems longer than 110 characters step down to `1.75rem` at `46ch` (`.stem-long`) so an explanatory question reads as a paragraph.
- Micro-labels (`.field-label`, status strip): `0.78rem`, uppercase, `0.08em` tracking — the lab site's editorial eyebrow.

## 3. Interaction patterns

- **One question per screen.** Grouping only where a validated instrument's administration requires it.
- **Options show only the options.** No letter keys, numbers or shortcut badges — nothing for a participant to decode. Selection is by tap, click, or Tab + Space.
- **Enter advances** everywhere, including from a typed answer — typing a name and pressing Enter moves straight on, matching how choices auto-advance. In a multi-field form, Enter walks down the fields and then advances from the last one. Long-form narrative text is the exception: Enter there inserts a line break.
- **Auto-advance** on single-choice after ~300 ms, suppressed under `prefers-reduced-motion`.
- **Progress is segmented hairlines**, one per reachable section — never a percentage where branching makes remaining length uncertain.
- **Motion is minimal**: 0.15–0.2 s colour/border transitions, a 1 px card lift on hover. No page transitions, no parallax, no confetti.
- **Vertically centred question block** with the action pinned bottom-right; falls back to top-aligned under 620 px height.
- **Skipping is deliberate, never blocked.** Pressing Next on an unanswered item asks "Leave this one blank?" in the footer's reserved strip — nothing above it moves, and no red alarm appears. "I'll answer it" is the prominent button; "Skip" is the quiet one. After three consecutive skips a check-in screen offers a route back to the first one.
- **Help is offered, not imposed.** A quiet "Remind me what this is about" reveals the item hint and the instrument instructions that framed it. After a long dwell on one item it changes to "Need a hand with this one?" — the only unprompted nudge in the interface.
- **Validation speaks plainly** and never blocks progress with jargon: "That would make you 2 — please check the year you were born", not "Invalid date".

## 4. Components

- **Cards** (`.card`): white on the canvas, hairline border, ≥56 px tall, label + tick. Selected = accent border and accent wash.
- **Illustrated tiles** (`.tile`): for options chosen by appearance. Each tile draws its pattern, shows the authoritative code (e.g. `2b`) and a plain-language gloss ("Defined waves"); the accessible name combines both.
- **Text inputs**: underline-only in display serif for short answers (feels like writing on paper, not filling a form); bordered paper block for long-form narrative.
- **Primary button**: near-black pill, white text. **Start/finish** use the accent pill. **Decline** is an underlined muted link — always available where the protocol permits, never disguised.
- **Ladder** (MacArthur): a drawn ladder — two rails, numbered rungs, highest at top — that responds to tap, drag and arrow keys, with researcher-authored anchor text at each end and a spoken-language confirmation ("You chose rung 8"). Exposed as `role=slider` with `aria-valuetext`.
- **Spectrum** (`.spectrum`): options on a left-to-right axis where the arrangement carries the meaning (handedness: Always left … Always right), with a drawing of the object above. Collapses to a vertical card list under 560 px. Display order may be reversed for a scale listed in the opposite direction — presentation only, codes never change.
- **Chips + ranked list**: pill chips for membership, numbered list with 44 px reorder buttons — the accessible two-step alternative to drag.

## 5. Accessibility (non-negotiable)

44 px minimum touch targets · visible `2px` accent focus ring with offset (pointer interaction never leaves a focus box) · full keyboard path · every control labelled from the definition layer, not visual order · WCAG 2.2 AA contrast (accent `#067843` on the canvas passes for text ≥16 px and for UI borders) · `prefers-reduced-motion` honoured · text scales to 200 % without loss · no colour-only meaning.

## 6. Applying this to new surfaces

MySelf Studio (researcher) uses the same tokens and fonts with a denser scale: `0.95rem` body, tables on `--paper` with hairline rules, the same accent for state. It may add data-dense components (tables, charts) but must not introduce a second colour system, a second type family, or heavier motion. Charts use the accent plus neutral greys; additional categorical colours must be drawn from the lab site's category accents (`#067843`, `#1e6091`, `#964f8c`).
