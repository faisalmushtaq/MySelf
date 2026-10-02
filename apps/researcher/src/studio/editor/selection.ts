/**
 * What is selected in the editor, and how that is written into the address.
 *
 * The selection lives in the URL (`?q=`), not only in component state, so a
 * link to "this question in the draft" can be pasted to a colleague, the Back
 * button behaves, and moving to the Preview tab can start the preview at the
 * question being edited (the preview reads the same parameter).
 *
 * Question IDs always contain a dot (`<instrument>.<key>`) and never a colon,
 * so every other kind of node is written with a prefix and cannot be mistaken
 * for one.
 */

export type Selection =
  | { kind: "welcome" }
  | { kind: "completion" }
  | { kind: "settings" }
  | { kind: "mystory" }
  | { kind: "section"; sectionKey: string }
  | { kind: "block"; sectionKey: string; componentIndex: number }
  | { kind: "question"; itemKey: string };

export function encodeSelection(selection: Selection | null): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "welcome":
    case "completion":
    case "settings":
    case "mystory":
      return selection.kind;
    case "section":
      return `section:${selection.sectionKey}`;
    case "block":
      return `block:${selection.sectionKey}:${selection.componentIndex}`;
    case "question":
      return selection.itemKey;
  }
}

export function decodeSelection(q: string | null | undefined): Selection | null {
  if (!q) return null;
  if (q === "welcome" || q === "completion" || q === "settings" || q === "mystory") return { kind: q };
  if (q.startsWith("section:")) {
    const sectionKey = q.slice("section:".length);
    return sectionKey ? { kind: "section", sectionKey } : null;
  }
  if (q.startsWith("block:")) {
    const [, sectionKey, index] = q.split(":");
    const componentIndex = Number(index);
    return sectionKey && Number.isInteger(componentIndex) && componentIndex >= 0
      ? { kind: "block", sectionKey, componentIndex }
      : null;
  }
  // The preview's own start points are not editor nodes.
  if (q === "finish" || q === "review") return { kind: "completion" };
  return q.includes(".") ? { kind: "question", itemKey: q } : null;
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return encodeSelection(a) === encodeSelection(b);
}
