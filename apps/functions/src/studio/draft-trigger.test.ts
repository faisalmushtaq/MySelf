import { describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { addQuestion, extractDraft, serialiseDraft, unlockModule, updateScreen, type StudioDraft } from "@myself/studio";
import { bundledManifests } from "../releases.js";
import {
  EDIT_WINDOW_MS,
  MAX_KEYS_PER_ROW,
  describeDraftWrite,
  editRowId,
  editWindow,
  mergeEditRow,
  unlockRowId,
  type DraftSide,
  type DraftWrite,
} from "./draft-trigger.js";

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));

/**
 * The draft's activity log, the part that decides (docs/16 §5.8).
 *
 * Firestore delivers a trigger's event at least once, so the row a save is
 * folded into has to come out the same however many times the save arrives,
 * and in whatever order two saves arrive. These tests hold that, and hold what
 * counts as an edit at all, without a database; the integration suite runs the
 * trigger's transaction against the emulator.
 */

const live = bundledManifests.find((b) => b.manifest.release.version === "7.1.0")!;
const base = (): StudioDraft => extractDraft(live.raw);
const T = (iso: string) => Timestamp.fromDate(new Date(iso));

const side = (draft: StudioDraft | string, revision: number, over: Partial<DraftSide> = {}): DraftSide => ({
  content: typeof draft === "string" ? draft : serialiseDraft(draft),
  revision,
  updatedBy: "u_ed",
  updatedByEmail: "ed.editor@example.org",
  updatedAt: T("2026-09-28T10:03:00Z"),
  ...over,
});

const edit = (write: DraftWrite) => {
  if (write.kind !== "edit") throw new Error(`expected an edit, got ${write.kind}: ${write.why}`);
  return write;
};

describe("what counts as an edit", () => {
  it("not the creation of a draft, nor its removal: functions do both, and audit them", () => {
    expect(describeDraftWrite(undefined, side(base(), 1)).kind).toBe("ignore");
    expect(describeDraftWrite(side(base(), 1), undefined).kind).toBe("ignore");
  });

  it("not the publish moving `basedOn`: content and revision unchanged", () => {
    const d = side(base(), 4);
    expect(describeDraftWrite(d, { ...d, updatedAt: T("2026-09-28T11:00:00Z") })).toEqual({ kind: "ignore", why: "content unchanged" });
  });

  it("a save: who (from the fields the rules force), which questions, which revisions", () => {
    const before = base();
    const section = before.composition.sections[1]!.key;
    const after = addQuestion(before, { sectionKey: section, typeId: "short_text", text: "What is your favourite colour?" }).draft;
    const write = edit(describeDraftWrite(side(before, 4), side(after, 5)));
    expect(write.editor).toEqual({ uid: "u_ed", email: "ed.editor@example.org" });
    expect(write.fromRevision).toBe(4);
    expect(write.toRevision).toBe(5);
    expect(write.itemKeys).toEqual(["ybm_studio.favourite_colour"]);
    expect(write.changes).toEqual(["question.added"]);
    expect(write.atMs).toBe(Date.parse("2026-09-28T10:03:00Z"));
    expect(write.unparsable).toBe(false);
  });

  it("a change outside the questions, recorded by what it touched", () => {
    const before = base();
    const after = updateScreen(before, "finish", { title: "Thank you so much" }).draft;
    const write = edit(describeDraftWrite(side(before, 4), side(after, 5)));
    expect(write.itemKeys).toEqual([]);
    expect(write.changes).toEqual(["completion.changed"]);
  });

  it("an unlock, with the reason kept and the editor's own claim of who kept apart", () => {
    const before = base();
    const reason = "Ethics amendment AM-3 approved the new consent wording on 20 September.";
    const after = unlockModule(before, "ybm_intro_consent", { by: "someone-else@example.org", at: "2026-09-28T10:02:00Z", reason }).draft;
    const write = edit(describeDraftWrite(side(before, 4), side(after, 5)));
    expect(write.unlocks).toEqual([{ instrument: "ybm_intro_consent", reason, claimedBy: "someone-else@example.org", claimedAt: "2026-09-28T10:02:00Z" }]);
    // Saving again with the unlock unchanged is not a second unlock.
    expect(edit(describeDraftWrite(side(after, 5), side(updateScreen(after, "finish", { title: "Thanks" }).draft, 6))).unlocks).toEqual([]);
  });

  it("a draft that cannot be read is still an edit — recorded, never thrown over", () => {
    for (const [b, a] of [
      [side(base(), 4), side("{not json", 5)],
      [side("{not json", 4), side(base(), 5)],
      [side(base(), 4), side(JSON.stringify({ format: "something-else" }), 5)],
      [side(base(), 4), { ...side(base(), 5), content: 42 }],
    ] as const) {
      const write = edit(describeDraftWrite(b, a));
      expect(write.unparsable).toBe(true);
      expect(write.itemKeys).toEqual([]);
    }
  });

  it("an unlock in a save that mends an unreadable draft is still recorded", () => {
    const reason = "Ethics amendment AM-3 approved the new consent wording on 20 September.";
    const after = unlockModule(base(), "ybm_intro_consent", { by: "u_ed", at: "2026-09-28T10:02:00Z", reason }).draft;
    const write = edit(describeDraftWrite(side("{not json", 4), side(after, 5)));
    expect(write.unparsable).toBe(true);
    expect(write.unlocks.map((u) => u.instrument)).toEqual(["ybm_intro_consent"]);
  });
});

describe("coalescing saves into one row per editor per ten minutes", () => {
  it("names the row by survey, editor and window, so every save in the window finds it", () => {
    const a = editWindow(Date.parse("2026-09-28T10:00:00Z"));
    expect(editWindow(Date.parse("2026-09-28T10:09:59.999Z"))).toBe(a);
    expect(editWindow(Date.parse("2026-09-28T10:10:00Z"))).toBe(a + 1);
    expect(EDIT_WINDOW_MS).toBe(600_000);
    expect(editRowId("ybm_nd2026_standard", "u_ed", a)).toBe(`ybm_nd2026_standard_draft_u_ed_${a}`);
  });

  it("gives an unlock a row whose ID the draft's text cannot shape", () => {
    const id = unlockRowId("s1", "../../evil/path", 7);
    expect(id).toMatch(/^s1_unlock_7_[0-9a-f]{16}$/);
    expect(unlockRowId("s1", "../../evil/path", 7)).toBe(id);
  });

  const save = (itemKeys: string[], from: number, to: number, iso: string): Extract<DraftWrite, { kind: "edit" }> => ({
    kind: "edit",
    editor: { uid: "u_ed", email: "ed.editor@example.org" },
    fromRevision: from,
    toRevision: to,
    atMs: Date.parse(iso),
    itemKeys,
    sections: [],
    changes: ["question.changed"],
    aspects: ["wording"],
    unlocks: [],
    unparsable: false,
  });

  const fold = (writes: Extract<DraftWrite, { kind: "edit" }>[]) => {
    let row: { detail: ReturnType<typeof mergeEditRow>["detail"]; at: Timestamp | null } | null = null;
    let subject = "";
    for (const w of writes) {
      const merged = mergeEditRow(row, w);
      row = { detail: merged.detail, at: merged.at };
      subject = merged.subject;
    }
    return { ...row!, subject };
  };

  const a = save(["kss.q1", "kss.q2"], 4, 5, "2026-09-28T10:01:00Z");
  const b = save(["kss.q2", "sdq.q3"], 5, 6, "2026-09-28T10:04:00Z");

  it("lists every question changed, once, with the revision range and the first and last save", () => {
    const row = fold([a, b]);
    expect(row.detail.itemKeys).toEqual(["kss.q1", "kss.q2", "sdq.q3"]);
    expect(row.subject).toBe("kss.q1, kss.q2, sdq.q3");
    expect(row.detail.fromRevision).toBe(4);
    expect(row.detail.toRevision).toBe(6);
    expect(row.detail.firstAt?.toMillis()).toBe(Date.parse("2026-09-28T10:01:00Z"));
    expect(row.at?.toMillis()).toBe(Date.parse("2026-09-28T10:04:00Z"));
  });

  it("comes out the same when a save is delivered twice", () => {
    expect(fold([a, b, b, a])).toEqual(fold([a, b]));
    expect(fold([a, a])).toEqual(fold([a]));
  });

  it("comes out the same whichever save arrives first, apart from the order questions are listed in", () => {
    const ab = fold([a, b]);
    const ba = fold([b, a]);
    expect(ba.detail.fromRevision).toBe(ab.detail.fromRevision);
    expect(ba.detail.toRevision).toBe(ab.detail.toRevision);
    expect(ba.at?.toMillis()).toBe(ab.at?.toMillis());
    expect(ba.detail.firstAt?.toMillis()).toBe(ab.detail.firstAt?.toMillis());
    expect([...ba.detail.itemKeys].sort()).toEqual([...ab.detail.itemKeys].sort());
  });

  it("has no counter to double", () => {
    expect(Object.keys(fold([a]).detail).sort()).toEqual(
      ["aspects", "changes", "firstAt", "fromRevision", "itemKeys", "sections", "toRevision", "truncated", "unparsable"].sort(),
    );
  });

  it("stays a bounded size however much is changed, and says when it stopped listing", () => {
    const many = save(
      Array.from({ length: MAX_KEYS_PER_ROW + 50 }, (_, i) => `m.q${i}`),
      1,
      2,
      "2026-09-28T10:01:00Z",
    );
    const row = fold([many]);
    expect(row.detail.itemKeys).toHaveLength(MAX_KEYS_PER_ROW);
    expect(row.detail.truncated).toBe(true);
    expect(fold([many, a]).detail.truncated).toBe(true);
  });

  it("remembers that a save in the window could not be read", () => {
    expect(fold([a, { ...b, unparsable: true, itemKeys: [] }, a]).detail.unparsable).toBe(true);
  });
});
