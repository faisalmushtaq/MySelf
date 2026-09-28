import { useId, useMemo, useState } from "react";
import { editTier, moveBlock } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Badge, Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { findBlock, type BlockRef } from "../node/BlockEditor.js";
import { Facts } from "../node/controls.js";
import { orderSignature } from "./SectionInspector.js";
import { refusal } from "./settings.js";

/**
 * A block's place in the survey: which section, where in it, and moving it —
 * whole, which is the only way a licensed questionnaire moves.
 */
export function BlockInspector({ sectionKey, componentIndex }: BlockRef) {
  const ctx = useEditor();
  const { draft } = ctx;
  const p = findBlock(draft, { sectionKey, componentIndex });
  const sections = draft.composition.sections;
  const signature = orderSignature(draft);
  const selectId = useId();
  const [target, setTarget] = useState("");
  const count = p ? (sections[p.sectionIndex]?.components.length ?? 0) : 0;

  const moves = useMemo(
    () => ({
      up: componentIndex <= 0 ? "first" : refusal(() => moveBlock(draft, { sectionKey, componentIndex }, { sectionKey, index: componentIndex - 1 })),
      down:
        componentIndex >= count - 1 ? "last" : refusal(() => moveBlock(draft, { sectionKey, componentIndex }, { sectionKey, index: componentIndex + 1 })),
    }),
    // Keyed by the order: typing elsewhere doesn't re-ask the model.
    [signature, sectionKey, componentIndex, count],
  );
  const destination = sections.find((s) => s.key === target);
  const toOther = useMemo(
    () =>
      destination
        ? refusal(() => moveBlock(draft, { sectionKey, componentIndex }, { sectionKey: destination.key, index: destination.components.length }))
        : null,
    [signature, sectionKey, componentIndex, destination],
  );
  if (!p) return null;
  const tier = editTier(draft, p.instrument);
  const name = p.def?.name ?? p.instrument;

  const moveWithin = (to: number) => {
    if (ctx.run(`Move the block “${name}”`, (d) => moveBlock(d, { sectionKey, componentIndex }, { sectionKey, index: to }).draft)) {
      ctx.select({ kind: "block", sectionKey, componentIndex: to });
      ctx.announce(`Moved “${name}” to position ${to + 1} of ${count} in its section.`);
    }
  };
  const moveTo = () => {
    if (!destination) return;
    const index = destination.components.length;
    if (ctx.run(`Move the block “${name}”`, (d) => moveBlock(d, { sectionKey, componentIndex }, { sectionKey: destination.key, index }).draft)) {
      ctx.select({ kind: "block", sectionKey: destination.key, componentIndex: index });
      ctx.announce(`Moved “${name}” to the end of “${destination.title}”.`);
      setTarget("");
    }
  };
  const reasons = [moves.up, moves.down].filter((m): m is string => m !== null && m !== "first" && m !== "last");

  return (
    <div className="sti">
      <header className="sti-head">
        <p className="sti-eyebrow">Block settings</p>
      </header>
      <section className="sti-group" aria-label="About this block">
        <Facts
          rows={[
            {
              label: "Kind",
              value:
                tier === "locked" ? (
                  <Badge icon="lock">Licensed questionnaire</Badge>
                ) : tier === "protected" ? (
                  <Badge tone="warn" icon="lock">
                    Protected module
                  </Badge>
                ) : (
                  "Study module"
                ),
            },
            { label: "Section", value: sections[p.sectionIndex]?.title ?? sectionKey },
            { label: "Position in section", value: `${componentIndex + 1} of ${count}` },
            { label: "Questions", value: p.subset ? `${p.items.length} (a chosen set, in this order)` : `${p.items.length} (all of it)` },
          ]}
        />
      </section>
      <section className="sti-group" aria-labelledby="sti-block-move">
        <h3 className="sti-title" id="sti-block-move">
          Move
        </h3>
        <div className="sti-actions">
          <Button size="sm" icon="arrow-up" onClick={() => moveWithin(componentIndex - 1)} disabled={!ctx.canEdit || moves.up !== null}>
            Move up
          </Button>
          <Button size="sm" icon="arrow-down" onClick={() => moveWithin(componentIndex + 1)} disabled={!ctx.canEdit || moves.down !== null}>
            Move down
          </Button>
        </div>
        {[...new Set(reasons)].map((m) => (
          <p key={m} className="sti-note">
            <Icon name="lock" size={14} /> {m}
          </p>
        ))}
        <div className="stn-field">
          <label className="stn-label" htmlFor={selectId}>
            Move to another section
          </label>
          <select id={selectId} className="st-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!ctx.canEdit}>
            <option value="">Choose a section…</option>
            {sections
              .filter((s) => s.key !== sectionKey)
              .map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
          </select>
          {toOther ? (
            <p className="sti-note">
              <Icon name="lock" size={14} /> {toOther}
            </p>
          ) : null}
        </div>
        <Button size="sm" onClick={moveTo} disabled={!ctx.canEdit || !destination || toOther !== null}>
          Move to the end of that section
        </Button>
        {tier === "locked" ? <p className="sti-note">A licensed questionnaire always moves whole, so its questions stay together in their validated order.</p> : null}
      </section>
    </div>
  );
}
