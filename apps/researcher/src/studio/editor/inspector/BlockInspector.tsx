import { useId, useMemo, useState } from "react";
import { editTier, moveBlock } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Button, InfoTip } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { findBlock, type BlockRef } from "../node/BlockEditor.js";
import { Facts } from "../node/controls.js";
import { focusSoon } from "../node/focus.js";
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

  const moveWithin = (to: number, dir: "up" | "down") => {
    if (ctx.run(`Move the block “${name}”`, (d) => moveBlock(d, { sectionKey, componentIndex }, { sectionKey, index: to }).draft)) {
      ctx.select({ kind: "block", sectionKey, componentIndex: to });
      ctx.announce(`Moved “${name}” to position ${to + 1} of ${count} in its section.`);
      // REVIEW FIX: the selection moves with the block, which redraws this panel
      // and dropped focus; put it back on the move buttons.
      focusSoon([`.sti [data-move="${dir}"]`, `.sti [data-move="${dir === "up" ? "down" : "up"}"]`]);
    }
  };
  const moveTo = () => {
    if (!destination) return;
    const index = destination.components.length;
    if (ctx.run(`Move the block “${name}”`, (d) => moveBlock(d, { sectionKey, componentIndex }, { sectionKey: destination.key, index }).draft)) {
      ctx.select({ kind: "block", sectionKey: destination.key, componentIndex: index });
      ctx.announce(`Moved “${name}” to the end of “${destination.title}”.`);
      setTarget("");
      focusSoon(['.sti [data-move="up"]', '.sti [data-move="down"]']);
    }
  };
  const reasons = [moves.up, moves.down].filter((m): m is string => m !== null && m !== "first" && m !== "last");

  return (
    <div className="sti">
      <section className="sti-group" aria-labelledby="sti-block-facts">
        <div className="sti-titlerow">
          <h3 className="sti-title" id="sti-block-facts">
            Block
          </h3>
        </div>
        <Facts
          rows={[
            {
              label: "Kind",
              value:
                tier === "locked" ? (
                  <span className="sti-flag">
                    <Icon name="lock" size={14} /> Licensed
                  </span>
                ) : tier === "protected" ? (
                  <span className="sti-flag">
                    <Icon name="lock" size={14} /> Protected
                  </span>
                ) : (
                  "Study module"
                ),
            },
            { label: "Section", value: sections[p.sectionIndex]?.title ?? sectionKey },
            { label: "Position", value: `${componentIndex + 1} of ${count}` },
            { label: "Questions", value: p.subset ? `${p.items.length} (a chosen set)` : `${p.items.length} (all of it)` },
          ]}
        />
      </section>
      <section className="sti-group" aria-labelledby="sti-block-move">
        <div className="sti-titlerow">
          <h3 className="sti-title" id="sti-block-move">
            Move
          </h3>
          {tier === "locked" ? (
            <InfoTip text="A licensed questionnaire always moves whole, so its questions stay together in their validated order." label="moving a licensed block" />
          ) : null}
        </div>
        <div className="sti-actions">
          <Button
            size="sm"
            variant="secondary"
            icon="arrow-up"
            data-move="up"
            onClick={() => moveWithin(componentIndex - 1, "up")}
            disabled={!ctx.canEdit || moves.up !== null}
          >
            Move up
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="arrow-down"
            data-move="down"
            onClick={() => moveWithin(componentIndex + 1, "down")}
            disabled={!ctx.canEdit || moves.down !== null}
          >
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
            Move to section
          </label>
          <div className="stn-inputrow">
            <select
              id={selectId}
              className="st-select"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!ctx.canEdit}
              aria-describedby={toOther ? `${selectId}-why` : undefined}
            >
              <option value="">Choose a section…</option>
              {sections
                .filter((s) => s.key !== sectionKey)
                .map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.title}
                  </option>
                ))}
            </select>
            <Button size="sm" variant="secondary" onClick={moveTo} disabled={!ctx.canEdit || !destination || toOther !== null}>
              Move
            </Button>
          </div>
          {toOther ? (
            <p id={`${selectId}-why`} className="sti-note">
              <Icon name="lock" size={14} /> {toOther}
            </p>
          ) : (
            <p className="sti-note">Moves it to the end of that section.</p>
          )}
        </div>
      </section>
    </div>
  );
}
