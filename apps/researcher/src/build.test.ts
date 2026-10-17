import { describe, expect, it } from "vitest";
import { buildDemoSessions, type DeviceSession } from "@myself/store";
import { buildDataset } from "./lib/build.js";
import { releases } from "./lib/releases.js";

/**
 * Building one dataset from sittings collected under several releases.
 *
 * The build reads a release at a time, oldest first. Nothing a participant did
 * may depend on that order: their waves follow the dates they sat, and twins
 * are twins whichever questionnaire each of them happened to answer.
 */

const release = (version: string) => releases.find((r) => r.version === version)!;
const older = release("7.0.0");
const newer = release("7.2.0");
const [base] = buildDemoSessions({ manifest: newer.manifest, participants: 1, seed: 7 });

const sitting = (id: string, under: typeof older, startedAt: string, firstName?: string): DeviceSession => ({
  ...base!,
  sessionId: id,
  releaseKey: under.key,
  releaseHash: under.hash,
  startedAt,
  events: base!.events.map((e) =>
    firstName && e.itemKey === "ybm_identity.first_name" ? { ...e, payload: { value: { kind: "text", value: firstName } } } : e,
  ),
});

describe("a dataset over interleaved releases", () => {
  it("numbers each person's waves by when they sat, not by release (F3)", () => {
    const built = buildDataset(
      [
        sitting("jan", older, "2026-01-10T09:00:00.000Z"),
        sitting("sep", older, "2026-09-10T09:00:00.000Z"),
        // An iPad that picked up the newer release early.
        sitting("mar", newer, "2026-03-10T09:00:00.000Z"),
      ],
      "YBM-ND2026",
    );
    expect(built.rejected).toEqual([]);
    expect(Object.fromEntries(built.dataset.sessions.map((s) => [s.sessionId, s.wave]))).toEqual({ jan: 1, mar: 2, sep: 3 });
  });

  it("reports one code carrying two names given under different releases (F2)", () => {
    const built = buildDataset(
      [sitting("t1", older, "2026-03-01T09:00:00.000Z", "Amara"), sitting("t2", newer, "2026-03-01T10:00:00.000Z", "Zayn")],
      "YBM-ND2026",
    );
    expect(built.collisions).toHaveLength(1);
    expect(built.collisions[0]!.names).toEqual(["amara", "zayn"]);
    expect(built.collisions[0]!.sessions).toEqual(["t1", "t2"]);
  });
});
