import { AnswerStore, Walker, type AnswerValue, type PresentableUnit } from "@myself/engine";
import type { ResponseScale } from "@myself/schema";
import { resolveText } from "../lib/pipes.js";

/**
 * The list of everything answered, reached from the finish screen.
 *
 * People notice a wrong answer when they see it written down, not while they
 * are giving it — so the whole session is laid out in order, grouped by
 * section, with every question tappable. It is *offered* rather than imposed
 * (D-31): most people are done when they are done, and a wall of everything
 * they just answered is a poor reward for finishing. Only questions this
 * participant actually saw appear: a branch they never entered is not
 * something they can have got wrong.
 *
 * Blanks are shown as blanks rather than hidden. "You left this one blank" is
 * information a participant may want to act on, and hiding it would quietly
 * turn a skip into a decision nobody revisits.
 */

export interface ReviewScreenProps {
  units: PresentableUnit[];
  scales: Map<string, ResponseScale>;
  store: AnswerStore;
  allowBack: boolean;
  sectionTitles: Map<string, string>;
  sessionStart: Date;
  title: string;
  body: string;
  onEdit: (index: number) => void;
  onFinish: () => void;
}

/** An answer in the words the participant chose, for reading back. */
export function describeAnswer(
  value: AnswerValue | undefined,
  scale: ResponseScale | undefined,
): string | null {
  if (!value) return null;
  switch (value.kind) {
    case "choice":
      return scale?.options.find((o) => o.code === value.code)?.label ?? String(value.code);
    case "multi": {
      const labels = value.codes.map(
        (c) => scale?.options.find((o) => o.code === c)?.label ?? String(c),
      );
      return labels.length ? labels.join(", ") : null;
    }
    case "number":
      return String(value.value);
    case "text":
      return value.value.trim() || null;
    case "date": {
      const d = new Date(`${value.iso}T00:00:00`);
      return Number.isNaN(d.getTime())
        ? value.iso
        : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    }
    case "fields": {
      const parts = Object.values(value.values)
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      return parts.length ? parts.join(" · ") : null;
    }
    case "checkboxes":
      return value.checked.length ? `${value.checked.length} agreed` : null;
    case "group_rank": {
      const entries = Object.entries(value.assignments);
      if (entries.length === 0) return null;
      // Ranked first, in rank order, then the rest — how the answer was given.
      const named = entries
        .map(([code, a]) => ({
          label: scale?.options.find((o) => o.code === Number(code))?.label ?? code,
          ...a,
        }))
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      return named.map((n) => n.label).join(", ");
    }
  }
}

export function ReviewScreen(props: ReviewScreenProps) {
  const { units, scales, store, allowBack, sectionTitles, sessionStart } = props;
  const walker = new Walker(units, store, allowBack, sessionStart);
  const visible = walker.visibleUnits();

  // Group in administered order, so the review reads like the session did.
  const groups: { key: string; title: string; rows: number[] }[] = [];
  for (const index of visible) {
    const unit = units[index]!;
    if (unit.item.responseType === "info") continue;
    const last = groups[groups.length - 1];
    if (last && last.key === unit.sectionKey) last.rows.push(index);
    else groups.push({ key: unit.sectionKey, title: sectionTitles.get(unit.sectionKey) ?? "", rows: [index] });
  }

  const answered = visible.filter((i) => {
    const u = units[i]!;
    return (
      u.item.responseType !== "info" &&
      store.get({ instrument: u.instrument, item: u.item.key, revision: u.item.revision })?.status === "answered"
    );
  }).length;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="screen review">
      <h1>{props.title}</h1>
      <p className="lede">{props.body}</p>
      <p className="review-count">
        {answered} of {total} answered
      </p>

      {groups.map((group) => (
        <section key={`${group.key}-${group.rows[0]}`} className="review-group">
          <h2 className="review-section">{group.title}</h2>
          <ul className="review-list">
            {group.rows.map((index) => {
              const unit = units[index]!;
              const item = unit.item;
              const record = store.get({ instrument: unit.instrument, item: item.key, revision: item.revision });
              const scale = "scale" in item ? scales.get(item.scale) : undefined;
              const answer = record?.status === "answered" ? describeAnswer(record.value, scale) : null;
              const stem = resolveText(item.stem.text, item.stem.pipes, store, sessionStart);
              return (
                <li key={`${unit.instrument}.${item.key}`}>
                  <button type="button" className="review-row" onClick={() => props.onEdit(index)}>
                    <span className="review-q">{stem}</span>
                    <span className={`review-a${answer === null ? " blank" : ""}`}>
                      {answer ?? "Left blank"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <div className="review-actions">
        <button type="button" className="next big" onClick={props.onFinish}>
          Done — back to the end
        </button>
      </div>
    </div>
  );
}
