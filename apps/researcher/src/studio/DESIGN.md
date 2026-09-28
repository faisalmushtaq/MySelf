# MySelf Studio — interface design

The Studio is a production tool that researchers use for hours at a time. It
should feel like the best software they already use: calm, precise, fast to
scan, and quiet. The survey being built is the loudest thing on screen. The
chrome around it recedes.

Reference points for the feel are Linear, Vercel, Stripe's dashboard, Notion
and Typeform's builder: neutral surfaces, one accent, thin lines, compact
controls and very little text. It must not read as a chat product or a
"friendly" consumer app. Avoid:

- warm cream or beige backgrounds;
- pill-shaped buttons everywhere;
- big rounded cards;
- chatty helper paragraphs.

The participant app is not affected: it keeps its own look (docs/11). The
Studio's preview frame renders the participant's own CSS and is not restyled.

## 1. Principles

1. **Quiet by default, clear on demand.**
   - Explanations live behind an info icon (a tooltip or popover), not in
     paragraphs under every field.
   - Visible helper text is kept only where a mistake would be costly, and then
     it is one short line.
2. **One accent.**
   - MySelf green (`--st-accent #067843`) marks the brand, the live state, the
     Publish action and the focus ring.
   - Everything else is neutral.
   - Warnings are amber and errors red. They are always paired with an icon and
     a word, never colour alone.
3. **Lines, not boxes.**
   - Separate areas with 1px hairlines and whitespace.
   - Cards are used sparingly, for things you act on as a unit.
   - Avoid nested borders.
4. **Dense but breathable.**
   - A 4px grid, 13–14px UI text, 32px controls.
   - Generous space around the survey content itself.
5. **Stable layout.**
   - Nothing jumps as you type.
   - Status changes swap text in place rather than adding banners.
   - Banners are only for things that block work, such as a conflict, a failed
     save or offline.
6. **Accessible without looking like it.**
   - WCAG 2.2 AA contrast.
   - A visible 2px focus ring.
   - Every control has a name, and state is never shown by colour alone.
   - Targets are at least 28px in dense lists and 32px elsewhere.

## 2. Tokens (defined once in `studio.css` on `.studio`)

| Token | Value | Use |
|---|---|---|
| `--st-bg` | `#FFFFFF` | Main canvas: the centre editor, pages |
| `--st-bg-subtle` | `#FAFAFA` | Side panels, page backgrounds behind white cards |
| `--st-bg-muted` | `#F4F4F5` | Hover rows, selected rows, input backgrounds when read-only |
| `--st-bg-emphasis` | `#E4E4E7` | Pressed states, progress tracks |
| `--st-border` | `#E4E4E7` | Default hairlines and dividers |
| `--st-border-strong` | `#D4D4D8` | Inputs, buttons (secondary) |
| `--st-text` | `#18181B` | Primary text |
| `--st-text-secondary` | `#52525B` | Secondary text, labels (7.7:1 on white) |
| `--st-text-tertiary` | `#71717A` | Meta text, placeholders, icons (4.8:1 — use at ≥12px only) |
| `--st-accent` | `#067843` | Primary action (Publish), live state, selection bar, focus ring |
| `--st-accent-hover` | `#05653A` | |
| `--st-accent-subtle` | `#ECF7F1` | Accent tinted background (live badge, success) |
| `--st-accent-text` | `#05653A` | Accent text on subtle background |
| `--st-warn` | `#B45309` | Warning text and icons (amber-700, 5.0:1) |
| `--st-warn-subtle` | `#FFFBEB` | Warning background |
| `--st-danger` | `#B91C1C` | Errors, destructive actions (red-700, 6.5:1) |
| `--st-danger-subtle` | `#FEF2F2` | Error background |
| `--st-info-subtle` | `#F4F4F5` | Neutral notices |
| `--st-radius-sm` | `4px` | Tags, kbd, small chips |
| `--st-radius` | `6px` | Buttons, inputs, menus items |
| `--st-radius-lg` | `8px` | Cards, popovers, panels |
| `--st-radius-xl` | `12px` | Dialogs |
| `--st-shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Raised controls (rare) |
| `--st-shadow-md` | `0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)` | Popovers, menus, toasts |
| `--st-shadow-lg` | `0 16px 48px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)` | Dialogs |
| `--st-focus` | `0 0 0 2px #FFFFFF, 0 0 0 4px rgba(6,120,67,0.55)` | Focus ring (keyboard only, `:focus-visible`) |
| `--st-font` | Inter, system-ui | One family. Tabular numbers for counts and versions |
| `--st-mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` | IDs, keys, hashes |

The older `--canvas`, `--text` and `--accent` tokens stay for the existing
researcher view, which is outside the Studio. Studio code uses only `--st-*`.

## 3. Type scale

| Role | Size / weight / line height | Notes |
|---|---|---|
| Page title | 20px / 600 / 28px | letter-spacing −0.01em |
| Section title | 15px / 600 / 22px | |
| Panel heading | 13px / 600 / 20px | Sentence case, not uppercase |
| Body / UI | 13px / 400 / 20px | Default in lists, tables, menus, inspector |
| Form input | 14px / 400 / 20px | Inputs and textareas |
| Label | 12px / 500 / 16px, `--st-text-secondary` | Above inputs |
| Meta | 12px / 400 / 16px, `--st-text-tertiary` | IDs, counts, timestamps |
| Question text (centre canvas) | 24px / 600 / 32px | The Typeform moment; `--st-text` |
| Question description | 15px / 400 / 24px, `--st-text-secondary` | |

Rules:
- No ALL-CAPS labels, except small table column headers (11px, 500, +0.04em)
  if needed.
- IDs and keys are always in `--st-mono` at 12px, `--st-text-tertiary`.

## 4. Layout

### Header (48px, white, bottom hairline)

- **Left:** a small MySelf mark (a 20px rounded square in accent, with a white
  "M"), then "Studio" in 13px/600, then `/` and the survey title in 13px/500.
- **Centre:** tabs (Edit · Preview · Versions · Settings) as 13px/500 text. The
  active tab is `--st-text`; the others are `--st-text-secondary`. A 2px accent
  underline sits under the active tab, flush with the header's bottom edge.
- **Right:** the account button, a 28px avatar circle with initials on
  `--st-bg-muted`. It opens a menu with the email, the role and sign out.

### Editor toolbar (44px, white, bottom hairline, under the header)

- **Left:** save state, as a 6px dot plus text: "Saved", "Saving…",
  "Unsaved", "Offline", "Save failed". Next to it, the live version: "Live
  r7.1.0". "Draft differs from live" is a small neutral tag.
- **Right:** undo and redo icon buttons, a divider, a checks chip ("6
  warnings" or "2 errors", with an icon), Preview (secondary), Publish
  (accent, solid). "?" goes into the account or overflow menu, not the
  toolbar.
- The survey's long title does not appear here; it is in the header.

### Three columns under the toolbar

- **Outline:** 288px, `--st-bg-subtle`, right hairline.
- **Centre:** fluid, `--st-bg`. The content column is at most 720px wide,
  centred, with 40px top padding.
- **Inspector:** 320px, `--st-bg-subtle`, left hairline.
- Each column scrolls on its own.

### Full pages (surveys, versions, settings, access)

- White canvas, content at most 960px wide, 32px top padding.
- A page title with an optional one-line description in secondary text.
- Primary actions sit top right.

## 5. Components

- **Buttons**
  - Height 32px (28px small), `--st-radius`, 13px/500. Icons are 16px.
  - *Primary:* `--st-text` background, white text. It is for the main action
    in a dialog or page.
  - *Accent:* green, and is for Publish and Make live only.
  - *Secondary:* white, `--st-border-strong` border, `--st-text`, with a
    `--st-bg-muted` hover.
  - *Ghost:* transparent, `--st-text-secondary`, with a `--st-bg-muted` hover.
  - *Danger:* a red outline, turning solid red in confirm dialogs.
  - No pills.
- **Icon buttons:** 28px square, `--st-radius`, ghost, with a tooltip.
- **Inputs:**
  - 32px, 14px text, a `--st-border-strong` border and `--st-radius`, with no
    inner shadow.
  - Focus: the border turns accent, plus the focus ring.
  - Invalid: a `--st-danger` border and a message line underneath (12px, icon
    and text).
  - Textareas grow with their content.
- **Inline-edit fields** (centre question canvas): no border at rest, a
  `--st-bg-muted` hover, and a border plus ring on focus. The question text is
  large and editable in place, as in Typeform.
- **Select:** a native `<select>` styled like an input, with a chevron.
- **Switch:** 28×16 track; on is accent, off is `--st-bg-emphasis`. The label
  is on the left and the switch right-aligned in inspector rows. Drop the
  visible "On/Off" words; the state is exposed through `role=switch`,
  `aria-checked`.
- **Segmented control:** a 28px-high group on `--st-bg-muted` with a 2px inner
  padding. The selected segment is white with `--st-shadow-sm`.
- **Tags and badges:** 20px high, `--st-radius-sm`, 12px/500.
  - Neutral: `--st-bg-muted` background, `--st-text-secondary` text.
  - Accent, warn and danger: the subtle background with the strong text.
  - Put an icon in front only when it adds meaning.
- **Status dot:** 6px circle, used for save state and live/previous. Always
  next to text.
- **Tooltips:**
  - `#18181B` background, white 12px text, `--st-radius`, 6px×8px padding.
  - They appear after 300ms on hover and immediately on focus.
- **Info tips:** a 14px ⓘ icon button (`--st-text-tertiary`) next to a label.
  It opens a short tooltip, or a popover for longer text. This is where the
  current helper paragraphs go.
- **Menus and popovers:**
  - White, `--st-radius-lg`, `--st-shadow-md`, a `--st-border` border and 4px
    padding.
  - Items are 30px, 13px, with a `--st-bg-muted` hover and 16px icons in
    `--st-text-tertiary`.
  - Destructive items are red.
- **Dialogs:**
  - 480px, or 640px for publish and compare.
  - `--st-radius-xl`, `--st-shadow-lg`, 24px padding.
  - Title 16px/600, and an optional description in 13px secondary text.
  - The footer is right-aligned with an 8px gap.
  - The overlay is `rgba(9,9,11,0.4)`.
- **Toasts:**
  - Bottom-centre, dark (`#18181B`), white 13px text, `--st-radius-lg`,
    `--st-shadow-md`.
  - An icon on the left and an optional action link.
  - They auto-dismiss, except errors.
- **Notices and banners:**
  - A single line, 36–40px, full width under the toolbar.
  - A subtle background of the matching tone, icon, text and an action on the
    right.
  - Use them only for blocking states.
- **Tables and lists** (versions, access):
  - Rows 44px with hairline separators and no zebra striping.
  - 12px/500 secondary column headers.
  - Hover row `--st-bg-subtle`.
- **Empty states:** a 32px tertiary icon, one 15px/600 line, one 13px secondary
  line and a single button.
- **Skeletons:** `--st-bg-muted` blocks with a subtle shimmer (none under
  reduced motion).

### Outline rows (the most-seen component)

- Row 32px, 8px horizontal padding, `--st-radius`.
- **Content:** a 16px type icon in `--st-text-tertiary`, then the question text
  in 13px `--st-text`, truncated to one line.
- **Trailing indicators** are 14px icons (tooltips give the names):
  - required, as a small asterisk;
  - condition, as a branch;
  - identifying, as a person;
  - an issue, as an amber or red icon plus its count.
- No text badges in rows. The question number and ID appear on hover or
  selection only, as tertiary meta.
- **Section headers:** 12px/600 `--st-text-secondary`, a disclosure chevron and
  the count as meta. Sections are separated by 8px of space, not boxes.
- **Licensed and protected blocks:** a collapsible group row with a 14px lock
  icon and the instrument's short name. There are no "Protected — unlock to
  edit" subtitles; that goes in a tooltip.
- **States:** hover is `--st-bg-muted`. Selected is `--st-bg-muted`, 500
  weight, and a 2px accent bar on the left edge, inset. The focus ring is on
  top.
- **"Add question":** a single 28px ghost row at the end of each section, "+
  Add question" in tertiary text, appearing fully on hover or focus. It stays
  visible for keyboard focus.

### Centre canvas for a question

- **Breadcrumb:** section › block as 12px secondary links, and the question
  number and ID as meta on the right.
- **Question text:** 24px/600, inline-editable. The description is 15px
  secondary, inline-editable, with the placeholder "Add a description
  (optional)".
- **Answer area:** a preview-like rendering of the options. Each is a 36px row
  with a drag handle on hover, an editable label and the stored value as a
  12px mono tag ("= 3") on the right, with a tooltip "Stored as 3 — never
  changes". Below the list: "+ Add option" and "+ Add ‘Other’" as ghost
  buttons.
- **Secondary content** (More information, Help text, Condition) sits in
  collapsed "+ Add …" rows until used.
- **Locked content:** a single slim notice line at the top ("Licensed
  questionnaire · wording locked", with ⓘ) instead of long banners. Locked
  fields render as plain text, not disabled inputs.

### Inspector

- **Groups:** Answer · Validation · Logic · Reporting · Status. Each group has
  a 13px/600 heading with 16px padding and a hairline between groups.
- **Rows:** label left (13px), control right, 36px row height. Longer
  descriptions go in info tips.
- **Required:** a switch, "Required", plus an ⓘ explaining skip behaviour. It
  replaces the two big radio cards.
- **Presentation:** a select, or a compact segmented control with icons,
  instead of large radio cards.
- **IDs:** a mono field with a copy icon button.

## 6. Copy

- Short labels:
  - "Question", "Description", "Help text", "More information";
  - "Answer type", "Options", "Required", "Allow “Prefer not to say”";
  - "Show if…", "Reporting label", "ID".
- Status in two or three words: "Saved", "Live r7.1.0", "2 errors", "Draft
  differs from live".
- Sentence case everywhere. No exclamation marks.
- Keep British English.
- Explanations that must stay (licence, ethics, identity, publishing
  consequences) move into info tips and dialogs, not the page.
- Confirmation dialogs keep a clear one or two sentence consequence statement.
  They are the right place for words.

## 7. Motion

- 120ms ease-out on colour, border and background changes.
- 160ms fade and 4px translate for popovers and dialogs.
- None under `prefers-reduced-motion`.
