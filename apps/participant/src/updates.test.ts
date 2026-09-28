import { describe, expect, it, vi } from "vitest";
import { mayActivateWaitingBuild, shouldReloadOnto, updateGate } from "./lib/updates.js";

/**
 * When the app may reload itself onto a new build.
 *
 * Both rules here exist because the unconditional version shipped and was wrong
 * in two ways at once: the first participant on every new iPad was returned to
 * the start screen moments after tapping Start, and a deploy landing mid-morning
 * did the same to a child answering question forty. Neither lost data — a sitting
 * is resumable — and both look exactly like the app crashing.
 */

describe("whether to reload onto a new build", () => {
  it("does not reload when no new build has taken over", () => {
    expect(
      shouldReloadOnto({ hadControllerAtLoad: true, newBuildTookOver: false, sittingInProgress: false }),
    ).toBe(false);
  });

  it("does not reload on a first install, which has nothing stale to replace", () => {
    // The first-load bug. With no controller at load, the worker installing and
    // taking over is the normal course of events, not a new build arriving.
    expect(
      shouldReloadOnto({ hadControllerAtLoad: false, newBuildTookOver: true, sittingInProgress: false }),
    ).toBe(false);
  });

  it("does not reload while somebody is part-way through a questionnaire", () => {
    expect(
      shouldReloadOnto({ hadControllerAtLoad: true, newBuildTookOver: true, sittingInProgress: true }),
    ).toBe(false);
  });

  it("reloads a genuinely superseded build when nobody is mid-sitting", () => {
    expect(
      shouldReloadOnto({ hadControllerAtLoad: true, newBuildTookOver: true, sittingInProgress: false }),
    ).toBe(true);
  });
});

describe("the gate over a school day", () => {
  it("holds an update that arrives mid-sitting, then applies it between participants", () => {
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });

    gate.hold();
    gate.tookOver();
    expect(reload).not.toHaveBeenCalled();
    expect(gate.waiting()).toBe(true);

    gate.release();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applies one straight away when the device is idle on a table", () => {
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });
    gate.tookOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once, however many times a sitting starts and ends afterwards", () => {
    // A reload that fired twice would be a loop on a device that is left alone.
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });
    gate.tookOver();
    gate.hold();
    gate.release();
    gate.hold();
    gate.release();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads a first install, even across several participants", () => {
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: false, reload });
    gate.tookOver();
    gate.hold();
    gate.release();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload between participants when no build ever arrived", () => {
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });
    gate.hold();
    gate.release();
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * A downloaded build takes over only when the gate says so (docs/16 R11).
 *
 * In "autoUpdate" mode a new build took control the moment it installed and the
 * plugin reloaded the page itself, so the rules above were being consulted too
 * late. The build now waits, and being told to take over is held back by the
 * same rule as the reload it leads to.
 */
describe("a new build waiting to take over", () => {
  it("is told to take over at once when nobody is mid-sitting", () => {
    const activate = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload: vi.fn() });
    gate.buildWaiting(activate);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(mayActivateWaitingBuild({ sittingInProgress: false })).toBe(true);
  });

  it("waits for the sitting in progress, then takes over and reloads between participants", () => {
    const activate = vi.fn();
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });

    gate.hold();
    gate.buildWaiting(activate);
    expect(activate).not.toHaveBeenCalled();
    expect(gate.waiting()).toBe(true);
    expect(mayActivateWaitingBuild({ sittingInProgress: true })).toBe(false);

    gate.release();
    expect(activate).toHaveBeenCalledTimes(1);
    // Taking over is what fires `controllerchange`; the reload follows from it.
    gate.tookOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload if a sitting starts between taking over and the new build arriving", () => {
    // Told to take over at the start screen, and a child pressed Start before the
    // new worker had control: the reload waits for the next start screen.
    const reload = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload });
    gate.buildWaiting(vi.fn());
    gate.hold();
    gate.tookOver();
    expect(reload).not.toHaveBeenCalled();
    gate.release();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applies only the newest of several builds that arrive during one sitting", () => {
    const first = vi.fn();
    const second = vi.fn();
    const gate = updateGate({ hadControllerAtLoad: true, reload: vi.fn() });
    gate.hold();
    gate.buildWaiting(first);
    gate.buildWaiting(second);
    gate.release();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // And once only, however many participants follow.
    gate.hold();
    gate.release();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
