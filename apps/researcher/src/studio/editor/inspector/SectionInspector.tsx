import { useMemo } from "react";
import { moveSection, outline, type StudioDraft } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts } from "../node/controls.js";
import { focusSoon } from "../node/focus.js";
import { refusal } from "./settings.js";

/**
 * A section's facts and its place in the survey. Moving it asks the model
 * first, so a move that would put a question before the consent, or move a
 * protected module, is shown disabled with the reason instead of refused.
 */

/** What the order of sections and blocks depends on — not titles, which change as they are typed. */
export function orderSignature(draft: StudioDraft): string {
  return JSON.stringify([
    draft.composition.sections.map((s) => [
      s.key,
      s.components.map((c) => (c.kind === "instrument" || c.kind === "module" ? [c.ref.instrument, c.items ?? null] : c.kind)),
    ]),
    Object.keys(draft.unlocked),
  ]);
}

export function copyText(text: string, announce: (m: string) => void): void {
  void navigator.clipboard?.writeText(text).then(
    () => announce(`Copied ${text}.`),
    () => announce("Couldn't copy. Select the text and copy it instead."),
  );
}

export function SectionInspector({ sectionKey }: { sectionKey: string }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const sections = draft.composition.sections;
  const index = sections.findIndex((s) => s.key === sectionKey);
  const signature = orderSignature(draft);
  const o = useMemo(() => outline(draft).sections[index], [draft, index]);
  // Keyed by the order, not the draft, so typing a title doesn't re-ask the model on every keystroke.
  const moves = useMemo(
    () => ({
      up: index <= 0 ? "It's already the first section." : refusal(() => moveSection(draft, sectionKey, index - 1)),
      down: index >= sections.length - 1 ? "It's already the last section." : refusal(() => moveSection(draft, sectionKey, index + 1)),
    }),
    [signature, sectionKey, index, sections.length],
  );
  if (!o) return null;
  const questions = o.blocks.reduce((n, b) => n + b.questions.length, 0);
  const conditional = o.blocks.reduce((n, b) => n + b.questions.filter((q) => q.hasCondition).length, 0);

  const move = (to: number, dir: "up" | "down") => {
    if (ctx.run(`Move the section “${o.title}”`, (d) => moveSection(d, sectionKey, to).draft)) {
      ctx.announce(`Moved “${o.title}” to position ${to + 1} of ${sections.length}.`);
      // REVIEW FIX: at the first or last place the button pressed becomes
      // disabled, which drops focus; keep it on the move buttons.
      focusSoon([`.sti [data-move="${dir}"]`, `.sti [data-move="${dir === "up" ? "down" : "up"}"]`]);
    }
  };

  return (
    <div className="sti">
      <section className="sti-group" aria-labelledby="sti-section-facts">
        <div className="sti-titlerow">
          <h3 className="sti-title" id="sti-section-facts">
            Section
          </h3>
        </div>
        <Facts
          rows={[
            {
              label: "ID",
              info: "Fixed: the data and the preview refer to the section by it.",
              value: (
                <span className="sti-idrow">
                  <code>{sectionKey}</code>
                  <IconButton icon="copy" size="sm" label={`Copy ${sectionKey}`} onClick={() => copyText(sectionKey, ctx.announce)} />
                </span>
              ),
            },
            { label: "Position", value: `${index + 1} of ${sections.length}` },
            { label: "Blocks", value: String(o.blocks.length) },
            { label: "Questions", value: String(questions) },
            { label: "Conditional", value: `${conditional} question${conditional === 1 ? "" : "s"}${o.hasCondition ? ", and the section" : ""}` },
          ]}
        />
      </section>
      <section className="sti-group" aria-labelledby="sti-section-move">
        <div className="sti-titlerow">
          <h3 className="sti-title" id="sti-section-move">
            Order
          </h3>
        </div>
        <div className="sti-actions">
          <Button size="sm" variant="secondary" icon="arrow-up" data-move="up" onClick={() => move(index - 1, "up")} disabled={!ctx.canEdit || moves.up !== null}>
            Move up
          </Button>
          <Button size="sm" variant="secondary" icon="arrow-down" data-move="down" onClick={() => move(index + 1, "down")} disabled={!ctx.canEdit || moves.down !== null}>
            Move down
          </Button>
        </div>
        {[moves.up, moves.down]
          .filter((m, i, all): m is string => m !== null && all.indexOf(m) === i && !m.startsWith("It's already"))
          .map((m) => (
            <p key={m} className="sti-note">
              <Icon name="lock" size={14} /> {m}
            </p>
          ))}
      </section>
    </div>
  );
}
