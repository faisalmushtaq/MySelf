import { describe, expect, it } from "vitest";
import { emptyDraft, type StudioDraft } from "@myself/studio";
import { MERGE_WINDOW_MS, record, redo, startHistory, undo, undoLabel } from "./history.js";

const base = emptyDraft({ surveyId: "s", study: "ybm", title: "One" });
const titled = (title: string): StudioDraft => ({ ...base, composition: { ...base.composition, title } });

describe("draft history", () => {
  it("undoes and redoes whole edits", () => {
    let h = startHistory(base);
    h = record(h, titled("Two"), "Rename survey", 1_000);
    h = record(h, titled("Three"), "Rename survey again", 1_100);
    expect(undoLabel(h)).toBe("Rename survey again");
    h = undo(h);
    expect(h.present.composition.title).toBe("Two");
    h = redo(h);
    expect(h.present.composition.title).toBe("Three");
  });

  it("merges a run of keystrokes in one field into one step", () => {
    let h = startHistory(base);
    h = record(h, titled("T"), "Edit wording", 1_000);
    h = record(h, titled("Th"), "Edit wording", 1_000 + MERGE_WINDOW_MS / 2);
    h = record(h, titled("The"), "Edit wording", 1_000 + MERGE_WINDOW_MS);
    expect(h.past).toHaveLength(1);
    expect(undo(h).present.composition.title).toBe("One");
  });

  it("drops the redo branch once something new is done", () => {
    let h = startHistory(base);
    h = record(h, titled("Two"), "a", 0);
    h = undo(h);
    h = record(h, titled("Other"), "b", 5_000);
    expect(h.future).toHaveLength(0);
  });
});
