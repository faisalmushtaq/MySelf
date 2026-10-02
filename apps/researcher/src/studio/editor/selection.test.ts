import { describe, expect, it } from "vitest";
import { decodeSelection, encodeSelection, type Selection } from "./selection.js";

describe("editor selection in the address", () => {
  const cases: Selection[] = [
    { kind: "welcome" },
    { kind: "completion" },
    { kind: "settings" },
    { kind: "section", sectionKey: "sleep" },
    { kind: "block", sectionKey: "wellbeing", componentIndex: 2 },
    { kind: "question", itemKey: "kss.q1" },
  ];

  it("round-trips every kind of node", () => {
    for (const s of cases) expect(decodeSelection(encodeSelection(s))).toEqual(s);
  });

  it("never reads a prefixed node as a question, or a question as anything else", () => {
    expect(decodeSelection("section:sleep")?.kind).toBe("section");
    expect(decodeSelection("ybm_identity.first_name")?.kind).toBe("question");
    expect(decodeSelection("not_a_question")).toBeNull();
    expect(decodeSelection("block:sleep:-1")).toBeNull();
    expect(decodeSelection("block:sleep:x")).toBeNull();
  });

  it("maps the preview's own start points onto the completion node", () => {
    expect(decodeSelection("finish")).toEqual({ kind: "completion" });
    expect(decodeSelection("review")).toEqual({ kind: "completion" });
  });
});
