# MySelf — Product Vision, User Journeys, Requirements, Information Architecture

## 1. Product vision (concise)

MySelf is a research-grade, offline-first platform for self-report and LLM-supported micro-narrative research with children, adolescents and adults. It pairs a consumer-quality participant experience — one thing per screen, instant, calm, touch-first — with the reproducibility guarantees longitudinal science needs: versioned instruments, immutable published releases, append-only raw data, complete provenance for every model call, and exports that carry everything needed to reconstruct exactly what each participant saw.

Two interfaces, one canonical definition layer:
- **MySelf Go** (participant PWA): installable on iPads from Safari, fully functional offline for conventional survey content, autosaving after every response.
- **MySelf Studio** (researcher app): instrument library, assessment composer, publishing, device/session monitoring, exports, instrument & narrative-protocol management.

Design north stars: participant effort minimised; nothing requires training; validity beats personalisation; published = immutable; raw ≠ derived, ever; offline is first-class; model text is always distinguishable from human text.

## 2. Primary user journeys

### Participant (school hall, managed iPad, offline)
1. Researcher hands over the iPad showing a neutral start screen (no trace of the previous participant).
2. Participant enters/confirms their team-issued ID (or scans a card QR); assent screen in age-appropriate language.
3. One item per screen; big touch targets; selecting a Likert/choice answer auto-advances after a ~250 ms confirmation tick; back is available where the protocol allows; "prefer not to say" is explicit where permitted.
4. Section transitions ("That's the sleep questions done — 3 of 6") with a segment progress indicator (segments, not a misleading percentage, when branching makes length uncertain).
5. Micro-narrative step: writes freely; sees clearly-labelled follow-up; if offline, the app says their story is saved and the study continues — no error, no waiting.
6. Finish screen with age-appropriate thanks + signposting; app returns to neutral start screen for handover.

### Researcher (composing and publishing)
1. Sign in (institutional SSO) → Studio dashboard.
2. New assessment → pick study → browse/search library → add instruments (each shows version, licence badge, per-age-band time estimate) → add bespoke modules and a narrative protocol → arrange sections.
3. Configure: age band, language, reading level for instructions (never touches validated wording), consent screens, branching, back-navigation policy, offline/narrative fallback behaviour.
4. Preview on phone/tablet/desktop frames; run validation (unreachable items, duplicate variables, broken pipes, licence blocks, missing narrative fallback).
5. Publish → immutable release with manifest hash, URL + QR code, printable spec.
6. Provision iPads: open Studio device mode on each iPad → download release bundle → verify assets → device shows "Ready, offline-capable".
7. During collection: dashboard shows sessions, unsynced counts per device, data-quality flags; after: export canonical/legacy datasets + codebook + manifests.

## 3. Prioritised requirements

### MVP (the polished vertical slice, per the brief §"The required MVP")
1. Instrument library encoding of the full YBM survey (validated instruments as versioned records incl. as-administered forms; bespoke modules).
2. Audited Qualtrics→MySelf mapping + anomaly decisions workflow (this docs set + machine-readable crosswalk).
3. Composer able to assemble the YBM composition; validation gate; immutable publish with manifest + URL/QR.
4. Participant PWA: all YBM response types (Likert, single/multi choice, dropdown→picker, slider, matrix→stepped items, drag-rank, text, date, form fields), branching, piping, autosave-per-response, offline completion, section progress, accessibility baseline (WCAG 2.2 AA targets).
5. Offline: release bundle download + verification; IndexedDB encrypted storage; multi-session per device; neutral handover; sync with idempotency + server ack; unsynced-count indicators; encrypted backup export.
6. Exports: canonical long + analysis wide + Qualtrics-legacy view; codebook, data dictionary, release manifest, migration crosswalk; scoring definitions (SDQ/RCADS/SWEMWBS/EHI/BIS-BAS/STAI-5) computed reproducibly, raw always preserved.
7. One micro-narrative protocol (`np.future_self@1.0`) — configurable request/prompts without code changes; staged records (participant text ≠ model output ≠ confirmation); queued generation when offline; safe failure; deterministic mock provider; provenance capture per model call.
8. Regression suite: YBM fixture tests (structure, codes, branching, scoring, export stability) + narrative module tests.
9. Researcher auth, roles (minimum: admin, researcher, data-viewer), audit log of draft edits and publishes.

### Release 2
- Randomisation/counterbalancing; matrix grouping option where a validated measure requires it; audio narrative capture; empirical time-estimate updating; data-quality flags (straight-lining, speeding); instrument/protocol approval workflows; multi-language forms; participant-owned-device flows (magic links); conversational support layer (opt-in, per-scope toggles); dashboard analytics (attrition, distributions); SPSS/Stata export syntax.

### Longer term
- Multi-study governance and archiving workflows; DDI-compatible metadata export; adaptive testing; on-device model feasibility work; NHS-grade deployment hardening (DSPT alignment); marketplace-style shared library across research groups; parent/teacher informant forms.

Explicitly deferred decisions (safe to defer): analytics warehouse choice; on-device LLM; additional languages; audio narratives; DDI export format details.

## 4. Information architecture

### Participant app (MySelf Go)
- **Start** (neutral; study branding only) → **ID/entry** → **Consent/assent** → **Sections** (items one-per-screen; section interstitials) → **Narrative module(s)** (request → write → optional follow-ups → optional confirm/correct) → **Finish** (thanks, signposting) → auto-return to Start.
- Persistent, unobtrusive status strip: online/offline dot + "saved" tick; nothing else.
- Hidden researcher unlock (long-press corner + PIN → device mode). No other hidden gestures.

### Researcher app (MySelf Studio)
- **Dashboard** (studies, live collection status, sync health, flags)
- **Library** (instruments · modules · narrative protocols · response scales; search/filter by construct, age band, language, licence, status; preview; versions & change history)
- **Composer** (assessment drafts; section canvas; component inspector; logic editor; preview; validation; publish)
- **Releases** (immutable list; manifest viewer; URL/QR; human-readable spec export; duplicate-as-new-draft)
- **Collection** (sessions; devices; sync queues; failed syncs; narrative processing queue; safeguarding flags [permission-gated])
- **Exports** (dataset builder; codebook/dictionary/manifest bundle; legacy view; export log)
- **Admin** (users/roles, studies/waves, audit log, retention)
- **Device mode** (on-iPad: readiness, installed releases, storage, unsynced sessions, backup export, handover lock)

## 5. Screen design descriptions (key screens)

**P1 Item screen (Likert):** question text top-left, max ~34 ch/line, 20 pt+; response options as full-width tappable cards (min 56 px) with number + label; selected card animates a tick then auto-advances (300 ms, disabled when `prefers-reduced-motion`); back chevron top-left (when permitted); segment progress dots top-right; "prefer not to say" as a visually quieter but fully accessible option below, where enabled. Keyboard: number keys select, arrows navigate, Enter confirms.
**P2 Matrix-as-steps:** validated matrices administered as a fast run of single items sharing a pinned scale header ("About the last 2 weeks"), preserving the instrument's instructions verbatim on an intro card; a compact "grid" fallback only where the measure's administration genuinely requires simultaneous display.
**P3 Drag-rank (apps):** two-column drop zones with large chips; on phones, a two-step alternative (multi-select "which do you have?", then drag-to-order list) — same data, better ergonomics; both render from the same item definition.
**P4 Narrative screen:** request text; roomy text area with gentle length meter (min/max from protocol); explicit save state ("Saved on this iPad"); model follow-up (when online & configured) visually labelled "Automatic follow-up"; confirm/correct step shows the model's interpretation in a distinct card with Agree / Change buttons.
**P5 Finish/handover:** thanks + signposting; then researcher-facing "Hand back to researcher" → neutral start.
**R1 Composer:** left = section outline (drag to reorder); centre = live device preview; right = inspector (version pin, required/optional, logic, reading level); bottom bar = total estimated time by age band + validation status; Publish disabled until validation passes.
**R2 Publish modal:** semantic release notes, diff vs previous release, manifest hash, URL + QR, printable spec.
**R3 Device mode (iPad):** big readiness card (release version, assets verified ✓, storage available, sessions unsynced n, last sync time), Sync now, Export encrypted backup, Return to participant mode (locks).

Accessibility commitments: WCAG 2.2 AA contrast; visible focus rings; full keyboard paths; screen-reader labels from the definition layer (not visual DOM order); scalable text to 200 % without loss; no colour-only meaning; reduced-motion honoured; error messages in plain language at the point of error; all controls ≥ 44×44 px touch targets; low-literacy mode = shorter navigational language only (never validated wording).
