import { memo } from "react";
import type { OutlineBlock } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { UNTITLED_QUESTION } from "../outline/model.js";
import type { Selection } from "../selection.js";
import { TYPE_ICONS, typeLabel } from "./types.js";

/**
 * The blocks and questions of a section (or one block), as quick links.
 *
 * Memoised on what the list says rather than on object identity: every edit
 * produces a new outline, and a section of 50 questions should not redraw
 * all 50 links on each keystroke in the section's title.
 */

export interface NodeListProps {
  blocks: OutlineBlock[];
  sectionKey: string;
  /** Show each block's own heading (a section's contents) or just its questions (a block's). */
  withBlocks: boolean;
  select: (selection: Selection) => void;
}

function signature(blocks: OutlineBlock[]): string {
  return JSON.stringify(
    blocks.map((b) => [b.componentIndex, b.name, b.tier, b.hasCondition, b.questions.map((q) => [q.itemKey, q.text, q.studioType, q.position, q.hasCondition])]),
  );
}

export const NodeList = memo(
  function NodeList({ blocks, sectionKey, withBlocks, select }: NodeListProps) {
    if (blocks.length === 0) return <p className="stn-inline-note">Nothing here yet.</p>;
    return (
      <div className="stn-nodelist">
        {blocks.map((b) => (
          <div key={b.componentIndex} className="stn-nodelist-block">
            {withBlocks ? (
              <button
                type="button"
                className="stn-nodelist-blockname"
                onClick={() => select({ kind: "block", sectionKey, componentIndex: b.componentIndex })}
              >
                <span className="stn-nodelist-blocktitle">{b.name}</span>
                {b.tier === "locked" || b.tier === "protected" ? (
                  <span className="stn-nodelist-flag" title={b.tier === "locked" ? "Licensed questionnaire" : "Protected module"}>
                    <Icon name="lock" size={14} />
                    <span className="st-sr">{b.tier === "locked" ? " (licensed)" : " (protected)"}</span>
                  </span>
                ) : null}
                {b.hasCondition ? (
                  <span className="stn-nodelist-flag" title="Shown only to some participants">
                    <Icon name="branch" size={14} />
                    <span className="st-sr"> (shown only to some)</span>
                  </span>
                ) : null}
                <Icon name="chevron-right" size={14} className="st-icon stn-nodelist-chevron" />
              </button>
            ) : null}
            <ol className="stn-nodelist-questions">
              {b.questions.map((q) => (
                <li key={q.itemKey}>
                  <button type="button" className="stn-nodelist-q" onClick={() => select({ kind: "question", itemKey: q.itemKey })}>
                    <span className="stn-nodelist-num st-num">{q.position + 1}</span>
                    <span className="stn-nodelist-icon" title={typeLabel(q.studioType)}>
                      <Icon name={TYPE_ICONS[q.studioType]} size={16} />
                      <span className="st-sr">{typeLabel(q.studioType)}: </span>
                    </span>
                    <span className="stn-nodelist-text">{q.text.trim() ? q.text : <em>{UNTITLED_QUESTION}</em>}</span>
                    {q.hasCondition ? (
                      <span className="stn-nodelist-if" title="Shown only to some participants">
                        <Icon name="branch" size={14} />
                        <span className="st-sr"> (shown only to some)</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    );
  },
  (a, b) => a.sectionKey === b.sectionKey && a.withBlocks === b.withBlocks && a.select === b.select && signature(a.blocks) === signature(b.blocks),
);
