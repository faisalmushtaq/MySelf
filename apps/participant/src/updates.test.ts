import { describe, expect, it, vi } from "vitest";
import { shouldReloadOnto, updateGate } from "./lib/updates.js";

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
