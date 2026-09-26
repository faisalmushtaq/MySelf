import { describe, expect, it } from "vitest";
import {
  confirmationProblem,
  sittingUpload,
  sittingsResponse,
  type SittingOutcome,
} from "./sync-contract.js";

/**
 * The wire format, from both sides.
 *
 * This is the one contract where disagreement is silent and expensive. A device that
 * sends a field the server drops, or reads a field the server no longer sends, syncs
 * "successfully" and then deletes sittings the study never received. So the shapes are
 * exercised here with the exact requests a device builds and the exact replies the
 * function returns — and with the malformed ones a school network produces instead.
 */

const event = (seq: number) => ({
  seq,
  type: "response.recorded",
  itemKey: "ybm_smartphone.sm_use",
  payload: { value: { kind: "choice", code: 1 }, timing: { sinceShownMs: 4200, tooFast: false } },
  tWall: "2026-09-01T10:00:05.000Z",
  tMono: 5_000,
});

/** Exactly what `apps/participant` posts. */
const request = {
  deviceId: "ipad_01JABCDEFGHJKMNPQRSTVWXYZ",
  sittings: [
    {
      sessionId: "ses_01JABCDEF",
      studyCode: "NDC0042",
      releaseKey: "ybm_nd2026_standard_r7_0_1",
      releaseHash: "sha256:b51b5b29c6ee2146623a4dc701c14954cdce9de1ba1689f32ee02a1bd0fa9013",
      startedAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:20:00.000Z",
      complete: true,
      events: [event(0), event(1)],
    },
  ],
};

describe("what a device sends", () => {
  it("is accepted as it is actually built", () => {
    expect(sittingUpload.safeParse(request).success).toBe(true);
  });

  it("is accepted without a deviceId, which is how a device that proves one sends", () => {
    const { deviceId: _claimed, ...rest } = request;
    expect(sittingUpload.safeParse(rest).success).toBe(true);
  });

  it("is accepted for a sitting still being answered", () => {
    const { completedAt: _unfinished, ...sitting } = request.sittings[0]!;
    expect(sittingUpload.safeParse({ sittings: [{ ...sitting, complete: false }] }).success).toBe(true);
  });

  it("keeps an event payload whole rather than reshaping it", () => {
    // The payload is the science. A schema that stripped unknown keys would silently
    // drop whatever a later build started recording.
    const parsed = sittingUpload.parse(request);
    expect(parsed.sittings[0]!.events[0]!.payload).toEqual(request.sittings[0]!.events[0]!.payload);
  });

  it("refuses a sitting with no events, which is nothing to store", () => {
    const sitting = { ...request.sittings[0]!, events: [] };
    // An empty log is structurally valid and semantically empty; it parses, and the
    // write path treats it as a zero-event sitting rather than an error.
    expect(sittingUpload.safeParse({ sittings: [sitting] }).success).toBe(true);
    expect(sittingUpload.safeParse({ sittings: [] }).success).toBe(false);
  });

  it("refuses the shapes a mangled request actually takes", () => {
    for (const bad of [
      {},
      { sittings: "one" },
      { sittings: [{ ...request.sittings[0]!, sessionId: "" }] },
      { sittings: [{ ...request.sittings[0]!, complete: "yes" }] },
      { sittings: [{ ...request.sittings[0]!, events: [{ ...event(0), seq: -1 }] }] },
      { sittings: [{ ...request.sittings[0]!, events: [{ ...event(0), tWall: "" }] }] },
      { sittings: [{ ...request.sittings[0]!, events: [{ ...event(0), payload: "a string" }] }] },
    ]) {
      expect(sittingUpload.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("caps a batch, so one request cannot be unbounded", () => {
    const fifty = Array.from({ length: 51 }, (_, i) => ({ ...request.sittings[0]!, sessionId: `ses_${i}` }));
    expect(sittingUpload.safeParse({ sittings: fifty }).success).toBe(false);
  });
});

describe("what the study replies", () => {
  it("is read as the function actually shapes it", () => {
    const reply = {
      stored: 1,
      outcomes: [{ sessionId: "ses_01JABCDEF", stored: true, events: 2, chunks: 0, quarantined: false }],
    };
    expect(sittingsResponse.safeParse(reply).success).toBe(true);
  });

  it("is read when a sitting was refused, reason and all", () => {
    const reply = {
      stored: 0,
      outcomes: [
        {
          sessionId: "ses_01JABCDEF",
          stored: false,
          events: 2,
          chunks: 0,
          quarantined: true,
          reason: "same sitting received from a second device",
        },
      ],
    };
    const parsed = sittingsResponse.parse(reply);
    expect(parsed.outcomes[0]!.reason).toMatch(/second device/);
  });

  it("refuses what a captive portal answers instead", () => {
    // The dangerous case: a school guest network replies 200 with its own body, and a
    // client that shrugged at it would confirm a sitting nobody stored.
    for (const bad of [
      null,
      "<!doctype html><title>Sign in</title>",
      { status: "redirect", url: "https://portal.school" },
      { stored: 1 },
      { stored: 1, outcomes: [{ sessionId: "ses_01JABCDEF", stored: true }] },
      { stored: 1, outcomes: [{ sessionId: 1, stored: true, events: 2, chunks: 0, quarantined: false }] },
    ]) {
      expect(sittingsResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});

describe("whether a sitting may be forgotten", () => {
  const outcome = (over: Partial<SittingOutcome> = {}): SittingOutcome => ({
    sessionId: "ses_01JABCDEF",
    stored: true,
    events: 900,
    chunks: 0,
    quarantined: false,
    ...over,
  });

  it("passes a sitting stored whole", () => {
    expect(confirmationProblem(outcome(), 900)).toBeNull();
  });

  it("refuses one stored short, which is the check the whole design rests on", () => {
    expect(confirmationProblem(outcome({ events: 400 }), 900)).toMatch(/stored 400 of the 900/);
  });

  it("refuses one stored long, because then the two disagree about the sitting", () => {
    expect(confirmationProblem(outcome({ events: 901 }), 900)).toMatch(/stored 901 of the 900/);
  });

  it("refuses one the server did not store, and passes the reason on", () => {
    expect(confirmationProblem(outcome({ stored: false, reason: "a sitting never gets shorter" }), 900)).toBe(
      "a sitting never gets shorter",
    );
  });

  it("says something even when the server refused without saying why", () => {
    expect(confirmationProblem(outcome({ stored: false }), 900)).toMatch(/did not store/);
  });

  it("does not treat a quarantined sitting as confirmed even when the count matches", () => {
    // Quarantined means the study is holding two copies that contradict each other.
    // The count agreeing is not permission to delete the device's evidence.
    expect(confirmationProblem(outcome({ stored: false, quarantined: true, events: 900 }), 900)).toBeTruthy();
  });
});
