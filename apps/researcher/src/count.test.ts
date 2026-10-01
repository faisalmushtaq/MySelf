import { describe, expect, it } from "vitest";
import { buildDemoSessions, type DeviceSession } from "@myself/store";
import { buildDataset, countStudy } from "./lib/build.js";
import { latestRelease } from "./lib/releases.js";

/**
 * What the Overview counts, by the rules the research dashboard counts by.
 *
 * The rules themselves are tested in @myself/store, and the dashboard feeds a whole
 * study through this path and its own and requires the figures to match. What is
 * checked here is the view's own wiring: every stored sitting reaches the count, test
 * sittings are left out unless asked for, and a sitting nobody can be linked to is
 * counted rather than lost.
 */

const now = new Date("2026-09-30T08:00:00.000Z");
const demo = buildDemoSessions({ manifest: latestRelease!.manifest, participants: 10 });
const anonymous: DeviceSession = {
  ...demo[0]!,
  sessionId: "ses_no_name",
  events: demo[0]!.events.filter((e) => !e.itemKey?.startsWith("ybm_identity.")),
};
const test: DeviceSession = { ...demo[1]!, sessionId: "ses_test", studyCode: "TST0001" };
const stranger: DeviceSession = { ...demo[2]!, sessionId: "ses_stranger", releaseHash: "sha256:unpublished" };
const sessions = [...demo, anonymous, test, stranger];
const { dataset, rejected } = buildDataset(sessions, "YBM");

describe("the Overview's count", () => {
  const counted = countStudy(sessions, dataset, false, now);

  it("counts every stored sitting except test sittings", () => {
    expect(counted.figures.sittings).toBe(sessions.length - 1);
    expect(counted.test).toEqual({ count: 1, included: false });
  });

  it("counts a sitting nobody can be linked to, and says how many there are", () => {
    expect(rejected.map((r) => r.sessionId)).toEqual(["ses_no_name"]);
    expect(counted.figures.notLinked).toBe(1);
    expect(counted.lifecycles.has("ses_no_name")).toBe(true);
  });

  it("shows and exports only the sittings it counts", () => {
    expect(counted.dataset.sessions.map((s) => s.sessionId)).not.toContain("ses_test");
    expect(counted.dataset.sessions).toHaveLength(counted.figures.linked);
  });

  it("counts test sittings when asked", () => {
    const all = countStudy(sessions, dataset, true, now);
    expect(all.figures.sittings).toBe(sessions.length);
    expect(all.dataset.sessions.map((s) => s.sessionId)).toContain("ses_test");
  });

  it("does not call a sitting incomplete by a release it was not collected under", () => {
    // buildDataset reads it through the latest release so its answers can be seen;
    // completeness is judged only against a sitting's own release.
    expect(dataset.sessions.map((s) => s.sessionId)).toContain("ses_stranger");
    expect(counted.lifecycles.get("ses_stranger")).toBe(stranger.complete ? "complete" : "abandoned");
  });
});
