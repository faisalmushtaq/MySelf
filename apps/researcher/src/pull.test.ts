import { describe, expect, it, vi } from "vitest";
import { splitSession, type SessionDoc } from "@myself/firebase";
import type { DeviceEvent, DeviceSession } from "@myself/store";
import { assemblePull } from "./lib/study.js";

/**
 * Getting the study back out.
 *
 * This is the path by which a researcher has any data at all, and it had no test. A bug
 * here means sittings that are safely in the database and unreachable — which is exactly
 * the failure the read path was built to fix, arriving from the other direction.
 *
 * Three behaviours matter and each is a decision rather than plumbing: a quarantined
 * sitting is left out because the study is holding two copies that contradict each other
 * and choosing between them is a person's job; a sitting whose chunks are missing is
 * NAMED rather than dropped, because `joinSession` refusing is the one thing standing
 * between a torn log and an analysis of it; and neither may take the rest of the pull
 * down with it.
 */

const event = (seq: number, chars = 20): DeviceEvent => ({
  seq,
  type: "response.recorded",
  itemKey: `inst.q${seq}`,
  payload: { value: { kind: "choice", code: seq % 5 }, pad: "x".repeat(chars) },
  tWall: "2026-09-01T10:00:00.000Z",
  tMono: seq * 1_000,
});

const sitting = (id: string, events: DeviceEvent[]): DeviceSession => ({
  sessionId: id,
  studyCode: "NDC0042",
  releaseKey: "ybm_nd2026_standard_r7_0_1",
  releaseHash: "sha256:abc",
  startedAt: "2026-09-01T10:00:00.000Z",
  completedAt: "2026-09-01T10:20:00.000Z",
  complete: true,
  events,
});

/** What the database actually holds for a sitting, split the way the server splits it. */
const asStored = (id: string, count: number, chars = 20) =>
  splitSession(sitting(id, Array.from({ length: count }, (_, i) => event(i, chars))), "ipad_a", "ybm");

const never = async () => {
  throw new Error("chunks should not have been fetched");
};

describe("assembling a pull", () => {
  it("returns an ordinary sitting whole", async () => {
    const stored = asStored("ses_1", 30);
    const pull = await assemblePull([stored.doc], never);

    expect(pull.sessions).toHaveLength(1);
    expect(pull.sessions[0]!.events).toHaveLength(30);
    expect(pull.sessions[0]!.studyCode).toBe("NDC0042");
    expect(pull.quarantined).toBe(0);
    expect(pull.unreadable).toEqual([]);
  });

  it("does not go looking for chunks a sitting does not have", async () => {
    // A normal sitting is one document. Reading a collection that does not exist for
    // every one of them would double the cost of a pull for nothing.
    const chunksFor = vi.fn(async () => []);
    await assemblePull([asStored("ses_1", 30).doc], chunksFor);
    expect(chunksFor).not.toHaveBeenCalled();
  });

  it("reassembles a spilled sitting in order", async () => {
    const stored = asStored("ses_big", 900, 900);
    expect(stored.doc.chunkCount).toBeGreaterThan(1);

    const pull = await assemblePull([stored.doc], async () => stored.chunks);
    expect(pull.sessions[0]!.events).toHaveLength(900);
    expect(pull.sessions[0]!.events.map((e) => e.seq)).toEqual([...Array(900).keys()]);
  });

  it("reassembles one whose chunks come back in the wrong order", async () => {
    // Firestore makes no promise about the order of a collection read.
    const stored = asStored("ses_big", 900, 900);
    const pull = await assemblePull([stored.doc], async () => [...stored.chunks].reverse());
    expect(pull.sessions[0]!.events.map((e) => e.seq)).toEqual([...Array(900).keys()]);
  });

  it("leaves a quarantined sitting out and counts it", async () => {
    // The study is holding two copies that contradict each other. Pulling either before
    // a person has decided is choosing for them.
    const good = asStored("ses_good", 10).doc;
    const held: SessionDoc = { ...asStored("ses_held", 10).doc, quarantined: true };

    const pull = await assemblePull([good, held], never);
    expect(pull.sessions.map((s) => s.sessionId)).toEqual(["ses_good"]);
    expect(pull.quarantined).toBe(1);
  });

  it("names a sitting whose chunks are missing, and still returns the others", async () => {
    // The one way a spilled sitting could lose data invisibly is a torn write: the parent
    // lands claiming four chunks and three arrive. `joinSession` refuses, and refusing
    // must not cost the rest of the pull.
    const torn = asStored("ses_torn", 900, 900);
    const fine = asStored("ses_fine", 20);

    const pull = await assemblePull([torn.doc, fine.doc], async () => torn.chunks.slice(0, -1));

    expect(pull.unreadable).toEqual(["ses_torn"]);
    expect(pull.sessions.map((s) => s.sessionId)).toEqual(["ses_fine"]);
  });

  it("names a sitting whose chunks could not be read at all", async () => {
    // A permission error or a dropped connection part way through a pull.
    const stored = asStored("ses_big", 900, 900);
    const pull = await assemblePull([stored.doc], async () => {
      throw new Error("permission denied");
    });
    expect(pull.unreadable).toEqual(["ses_big"]);
    expect(pull.sessions).toEqual([]);
  });

  it("keeps the time the study last received each sitting", async () => {
    // The server's clock decides whether an unfinished sitting is in progress or
    // abandoned, here as in the dashboard; a device clock can be hours out.
    const stored = asStored("ses_1", 10).doc;
    const pull = await assemblePull([{ ...stored, receivedAt: "2026-09-02T08:00:00.000Z" }], never);
    expect(pull.sessions[0]!.receivedAt).toBe("2026-09-02T08:00:00.000Z");
  });

  it("returns nothing, calmly, from an empty study", async () => {
    expect(await assemblePull([], never)).toEqual({ sessions: [], quarantined: 0, unreadable: [] });
  });

  it("handles a study of many sittings without mixing them up", async () => {
    const stored = Array.from({ length: 40 }, (_, i) => asStored(`ses_${i}`, 10 + i).doc);
    const pull = await assemblePull(stored, never);

    expect(pull.sessions).toHaveLength(40);
    for (let i = 0; i < 40; i += 1) {
      const found = pull.sessions.find((s) => s.sessionId === `ses_${i}`)!;
      expect(found.events).toHaveLength(10 + i);
    }
  });
});
