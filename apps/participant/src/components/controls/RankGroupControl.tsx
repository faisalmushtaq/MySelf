import { useMemo } from "react";
import type { ControlProps } from "./shared.js";

/** Two-step group + rank (documented small-screen alternative to drag — docs/04 P3). */
export function RankGroupControl({ item, scale, value, onAnswer }: ControlProps) {
  if (item.responseType !== "rank_group" || !scale) return null;
  const rankedGroup = item.groups.find((g) => g.ranked) ?? item.groups[0]!;
  const otherGroup = item.groups.find((g) => g.key !== rankedGroup.key)!;

  const assignments = useMemo(
    () => (value?.kind === "group_rank" ? value.assignments : {}),
    [value],
  );
  const inRanked = scale.options
    .filter((o) => assignments[o.code]?.group === rankedGroup.key)
    .sort((a, b) => (assignments[a.code]?.rank ?? 0) - (assignments[b.code]?.rank ?? 0));

  const emit = (next: Record<number, { group: string; rank?: number }>) => {
    // Complete the assignment: unassigned options implicitly go to the other group.
    const full: Record<number, { group: string; rank?: number }> = {};
    for (const o of scale.options) full[o.code] = next[o.code] ?? { group: otherGroup.key };
    onAnswer({ kind: "group_rank", assignments: full }, false);
  };

  const toggle = (code: number) => {
    const next = { ...assignments };
    if (next[code]?.group === rankedGroup.key) {
      next[code] = { group: otherGroup.key };
      // re-rank remaining
      let rank = 1;
      for (const o of inRanked.filter((x) => x.code !== code)) next[o.code] = { group: rankedGroup.key, rank: rank++ };
    } else {
      next[code] = { group: rankedGroup.key, rank: inRanked.length + 1 };
    }
    emit(next);
  };

  const move = (code: number, dir: -1 | 1) => {
    const order = inRanked.map((o) => o.code);
    const i = order.indexOf(code);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
    const next = { ...assignments };
    order.forEach((c, idx) => (next[c] = { group: rankedGroup.key, rank: idx + 1 }));
    emit(next);
  };

  return (
    <div className="rank-group">
      <p className="hint">Step 1 — tap everything that applies to “{rankedGroup.label}”.</p>
      <div className="chips" role="group">
        {scale.options.map((o) => {
          const on = assignments[o.code]?.group === rankedGroup.key;
          return (
            <button key={o.code} type="button" aria-pressed={on} className={`chip${on ? " on" : ""}`} onClick={() => toggle(o.code)}>
              {o.label}
            </button>
          );
        })}
      </div>
      {inRanked.length > 1 && (
        <>
          <p className="hint">Step 2 — order them from most used (top) to least used.</p>
          <ol className="rank-list">
            {inRanked.map((o) => (
              <li key={o.code} className="rank-item">
                <span>{o.label}</span>
                <span className="rank-buttons">
                  <button type="button" aria-label={`Move ${o.label} up`} onClick={() => move(o.code, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${o.label} down`} onClick={() => move(o.code, 1)}>
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
