import { useSyncExternalStore } from "react";

/**
 * The outline's fast-changing, per-row state: which row is selected, which one
 * holds the keyboard's tab stop, and where a drag would drop.
 *
 * Kept outside React state on purpose. Each row subscribes to its own slice
 * (a short string), so moving the selection or dragging over the tree
 * re-renders the two or three rows whose state changed — not every row, as
 * passing `selectedId` down as a prop would.
 */

export type DropEdge = "before" | "after" | "inside";

export interface DropMark {
  id: string;
  edge: DropEdge;
  /** The model will refuse this drop; drawn differently, and said in words above the tree. */
  refused: boolean;
}

interface State {
  selected: string | null;
  active: string | null;
  drop: DropMark | null;
}

export class RowStore {
  private state: State = { selected: null, active: null, drop: null };
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get selected(): string | null {
    return this.state.selected;
  }

  get active(): string | null {
    return this.state.active;
  }

  get drop(): DropMark | null {
    return this.state.drop;
  }

  set(patch: Partial<State>): void {
    const next = { ...this.state, ...patch };
    const same =
      next.selected === this.state.selected &&
      next.active === this.state.active &&
      (next.drop === this.state.drop ||
        (!!next.drop && !!this.state.drop && next.drop.id === this.state.drop.id && next.drop.edge === this.state.drop.edge && next.drop.refused === this.state.drop.refused));
    if (same) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** One row's slice, as a string so equal states compare equal. */
  rowState(id: string): string {
    const { selected, active, drop } = this.state;
    const mark = drop && drop.id === id ? `${drop.edge}${drop.refused ? "!" : ""}` : "";
    return `${selected === id ? 1 : 0}${active === id ? 1 : 0}${mark}`;
  }
}

export interface RowState {
  selected: boolean;
  active: boolean;
  drop: DropEdge | null;
  refused: boolean;
}

export function useRowState(store: RowStore, id: string): RowState {
  const s = useSyncExternalStore(store.subscribe, () => store.rowState(id));
  const mark = s.slice(2);
  return {
    selected: s[0] === "1",
    active: s[1] === "1",
    drop: mark ? (mark.replace("!", "") as DropEdge) : null,
    refused: mark.endsWith("!"),
  };
}
