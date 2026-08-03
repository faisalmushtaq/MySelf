import { describe, expect, it } from "vitest";
import type { DeviceSession, DeviceEvent } from "@myself/store";
import { EVENTS_PER_CHUNK, MAX_DOCUMENT_BYTES, conflictWith, joinSession, paths, splitSession } from "./layout.js";

/**
 * A bug here loses a whole sitting at the moment it is handed over, so the
 * round trip is tested at both the normal size and the size that spills.
 */

const event = (seq: number, padding = ""): DeviceEvent => ({
  seq,
  type: "response.recorded",
  itemKey: `inst.q${seq}`,
  payload: { value: { kind: "text", value: `answer ${seq}${padding}` } },
  tWall: "2026-09-01T09:00:00.000Z",
  tMono: seq * 1000,
});

const session = (events: DeviceEvent[]): DeviceSession => ({
  sessionId: "ses_1",
  studyCode: "NDC0042",
  releaseKey: "ybm_nd2026_standard",
  releaseHash: "sha256:abc",
  startedAt: "2026-09-01T09:00:00.000Z",
  completedAt: "2026-09-01T09:20:00.000Z",
  complete: true,
  events,
});

describe("one document per sitting", () => {
  it("keeps a normal sitting inline, so reading the study is one read per sitting", () => {
    const { doc, chunks } = splitSession(session(Array.from({ length: 295 }, (_, i) => event(i))), "dev_a", "ybm");
    expect(chunks).toHaveLength(0);
    expect(doc.chunkCount).toBe(0);
    expect(doc.events).toHaveLength(295);
    expect(doc.eventCount).toBe(295);
  });

  it("round-trips exactly", () => {
    const original = session(Array.from({ length: 295 }, (_, i) => event(i)));
    const { doc, chunks } = splitSession(original, "dev_a", "ybm");
    expect(joinSession(doc, chunks)).toEqual(original);
  });

  it("stamps the device and study, which the rules check against the caller", () => {
    const { doc } = splitSession(session([event(0)]), "dev_a", "ybm");
    expect(doc.deviceId).toBe("dev_a");
    expect(doc.study).toBe("ybm");
  });
});

describe("the sitting that has to spill", () => {
  // Roughly 3 kB of payload each: an implausible sitting, which is the point.
  const huge = Array.from({ length: 400 }, (_, i) => event(i, "x".repeat(3000)));

  it("spills into chunks rather than failing the write", () => {
    const { doc, chunks } = splitSession(session(huge), "dev_a", "ybm");
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.events).toHaveLength(0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(doc.eventCount).toBe(huge.length);
  });

  it("still round-trips, in order", () => {
    const original = session(huge);
    const { doc, chunks } = splitSession(original, "dev_a", "ybm");
    const rejoined = joinSession(doc, chunks);
    expect(rejoined.events).toHaveLength(huge.length);
    expect(rejoined.events.map((e) => e.seq)).toEqual(huge.map((e) => e.seq));
    expect(rejoined).toEqual(original);
  });

  it("rejoins correctly even when the chunks come back out of order", () => {
    // Firestore makes no promise about the order of a collection read.
    const original = session(huge);
    const { doc, chunks } = splitSession(original, "dev_a", "ybm");
    expect(joinSession(doc, [...chunks].reverse())).toEqual(original);
  });

  it("keeps every chunk clear of the document limit, whatever the events weigh", () => {
    // Chunking on event count alone produced chunks over the limit as soon as
    // the answers got long — which fails the write and loses the sitting the
    // spill exists to save. Packed to a byte budget now.
    for (const size of [500, 3000, 20_000]) {
      const events = Array.from({ length: 200 }, (_, i) => event(i, "x".repeat(size)));
      const { chunks, doc } = splitSession(session(events), "dev_a", "ybm");
      for (const chunk of chunks) {
        expect(JSON.stringify(chunk).length, `${size}b events`).toBeLessThan(MAX_DOCUMENT_BYTES);
      }
      expect(JSON.stringify(doc).length).toBeLessThan(MAX_DOCUMENT_BYTES);
      expect(joinSession(doc, chunks).events).toHaveLength(events.length);
    }
  });

  it("gives an event too large to share a chunk one of its own", () => {
    // Larger on its own than the whole budget, so it cannot share with anything.
    const events = [event(0), event(1, "x".repeat(800_000)), event(2)];
    const { doc, chunks } = splitSession(session(events), "dev_a", "ybm");
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinSession(doc, chunks).events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("splitting is deterministic", () => {
  it("gives byte-identical documents for the same sitting, so a retry overwrites", () => {
    const original = session(Array.from({ length: 300 }, (_, i) => event(i)));
    const first = splitSession(original, "dev_a", "ybm", new Date("2026-09-01T10:00:00.000Z"));
    const second = splitSession(original, "dev_a", "ybm", new Date("2026-09-01T10:00:00.000Z"));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not depend on the order the device happened to send events in", () => {
    const ordered = Array.from({ length: 50 }, (_, i) => event(i));
    const shuffled = [...ordered].reverse();
    expect(JSON.stringify(splitSession(session(shuffled), "dev_a", "ybm", new Date(0)))).toBe(
      JSON.stringify(splitSession(session(ordered), "dev_a", "ybm", new Date(0))),
    );
  });
});

describe("conflicts", () => {
  const stored = splitSession(session([event(0)]), "dev_a", "ybm").doc;

  it("passes a first arrival", () => {
    expect(conflictWith(null, stored)).toBeNull();
  });

  it("passes the same device finishing its own sitting", () => {
    expect(conflictWith(stored, stored)).toBeNull();
  });

  it("catches a second device claiming the sitting", () => {
    const other = splitSession(session([event(0)]), "dev_b", "ybm").doc;
    expect(conflictWith(stored, other)).toMatch(/second device/);
  });

  it("catches a contradicting release", () => {
    expect(conflictWith(stored, { ...stored, releaseHash: "sha256:other" })).toMatch(/release hash/);
  });
});

describe("paths", () => {
  it("keeps the two projects' collections apart by name as well as by project", () => {
    expect(paths.session("ybm", "s1")).toBe("studies/ybm/sessions/s1");
    expect(paths.participant("ybm", "JA101CD")).toBe("studies/ybm/participants/JA101CD");
    expect(paths.sessionChunk("ybm", "s1", 3)).toBe("studies/ybm/sessions/s1/chunks/0003");
  });
});
