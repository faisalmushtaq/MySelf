import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daysHeld,
  EVICTION_CAP_DAYS,
  forgetDurability,
  HELD_TOO_LONG_DAYS,
  storageDurability,
} from "./lib/durability.js";
import type { SessionRow } from "./lib/db.js";

/**
 * Whether the browser will keep what this iPad is holding.
 *
 * THE LOSS THIS IS ABOUT is not storage pressure and not a failed write — both are
 * handled elsewhere and both are visible when they happen. It is WebKit deleting a
 * site's IndexedDB after seven days of the site not being opened, which takes a
 * fielded iPad's entire unsynced morning with it, silently, while the device sits in
 * a cupboard between school visits.
 *
 * SO THE THING UNDER TEST IS A JUDGEMENT, not an API call: given what this browser
 * will and will not promise, is the data at risk. Getting that wrong in the
 * reassuring direction is the expensive mistake — an operator told the data is safe
 * puts the device away — so most of what follows is about the cases where we did not
 * get a promise and must not pretend we did.
 */

const stubStorage = (storage: unknown) => {
  const had = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", { value: storage, configurable: true });
  return () => {
    if (had) Object.defineProperty(navigator, "storage", had);
    else delete (navigator as unknown as Record<string, unknown>)["storage"];
  };
};

/**
 * A window, because the tests run under Node and `display-mode` needs one.
 *
 * `standalone` is iOS Safari's own flag and the only one an iPad before 16.4 sets, so
 * both routes have to be stubbable independently — a device that answers one and not
 * the other is the normal case in a school's mixed set of iPads.
 */
const stubWindow = (opts: { displayMode?: boolean; standalone?: boolean }) => {
  const hadWindow = "window" in globalThis;
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({ matches: opts.displayMode === true && query.includes("standalone") }),
  };
  const hadStandalone = Object.getOwnPropertyDescriptor(navigator, "standalone");
  Object.defineProperty(navigator, "standalone", { value: opts.standalone, configurable: true });
  return () => {
    if (hadWindow) (globalThis as { window?: unknown }).window = previous;
    else delete (globalThis as { window?: unknown }).window;
    if (hadStandalone) Object.defineProperty(navigator, "standalone", hadStandalone);
    else delete (navigator as unknown as Record<string, unknown>)["standalone"];
  };
};

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  forgetDurability();
});

const withBrowser = (storage: unknown, window: { displayMode?: boolean; standalone?: boolean } = {}) => {
  restores.push(stubStorage(storage), stubWindow(window));
};

describe("asking the browser to keep this device's data", () => {
  it("is safe once the browser has granted persistence", async () => {
    withBrowser({ persisted: async () => false, persist: async () => true });
    const durability = await storageDurability();
    expect(durability.promise).toBe("granted");
    expect(durability.atRisk).toBe(false);
  });

  it("does not ask again when persistence was already granted", async () => {
    const persist = vi.fn(async () => true);
    withBrowser({ persisted: async () => true, persist });
    expect((await storageDurability()).promise).toBe("granted");
    // Asking again can put a permission prompt in front of a child mid-sitting in
    // browsers that prompt, for an answer we already have.
    expect(persist).not.toHaveBeenCalled();
  });

  it("treats a refusal as a risk, not as an error", async () => {
    withBrowser({ persisted: async () => false, persist: async () => false });
    const durability = await storageDurability();
    expect(durability.promise).toBe("refused");
    expect(durability.atRisk).toBe(true);
  });

  /**
   * The iPad case, and the reason this module exists. Safari implements
   * `estimate()` and neither `persisted()` nor `persist()`, so there is no promise
   * to be had and the only protection is the Home Screen.
   */
  it("reports a browser that cannot be asked as at risk when it is a plain tab", async () => {
    withBrowser({ estimate: async () => ({ usage: 1, quota: 2 }) });
    const durability = await storageDurability();
    expect(durability.promise).toBe("unsupported");
    expect(durability.installed).toBe(false);
    expect(durability.atRisk).toBe(true);
  });

  it("is safe on an iPad launched from the Home Screen even with no persistence API", async () => {
    withBrowser({ estimate: async () => ({ usage: 1, quota: 2 }) }, { standalone: true });
    const durability = await storageDurability();
    expect(durability.promise).toBe("unsupported");
    expect(durability.installed).toBe(true);
    // The seven-day cap does not apply to a Home Screen web app. This is the whole
    // mitigation the panel asks the operator for, so it must read as safe.
    expect(durability.atRisk).toBe(false);
  });

  it("recognises an installed app by display-mode, for iPads new enough to say so", async () => {
    withBrowser({ estimate: async () => ({ usage: 1, quota: 2 }) }, { displayMode: true });
    expect((await storageDurability()).installed).toBe(true);
  });

  it("does not mistake a plain tab for an installed app", async () => {
    withBrowser({}, { displayMode: false, standalone: false });
    expect((await storageDurability()).installed).toBe(false);
  });

  it("reports a risk rather than throwing when asking is a security error", async () => {
    withBrowser({
      persisted: async () => {
        throw new Error("the operation is insecure");
      },
    });
    // A thrown error here would take out the panel that exists to carry the warning,
    // so the failure has to land as the cautious answer instead.
    const durability = await storageDurability();
    expect(durability.promise).toBe("unsupported");
    expect(durability.atRisk).toBe(true);
  });

  it("survives a browser with no storage object at all", async () => {
    withBrowser(undefined);
    expect((await storageDurability()).atRisk).toBe(true);
  });

  it("asks once per launch", async () => {
    const persist = vi.fn(async () => true);
    withBrowser({ persisted: async () => false, persist });
    await storageDurability();
    await storageDurability();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

const session = (state: SessionRow["state"], startedAt: string): Pick<SessionRow, "state" | "startedAt"> => ({
  state,
  startedAt,
});

describe("how long this device has been carrying data", () => {
  const now = new Date("2026-09-27T09:00:00.000Z");

  it("says nothing when the device is holding nothing", () => {
    expect(daysHeld([], now)).toBe(null);
  });

  it("says nothing when every sitting has been confirmed by the study", () => {
    // The state a fielded device should end each day in. A number here would have
    // operators chasing data that is already safely in the database.
    expect(daysHeld([session("synced_verified", "2026-09-01T09:00:00.000Z")], now)).toBe(null);
  });

  it("counts from the oldest sitting the study has not confirmed", () => {
    const held = [
      session("synced_verified", "2026-08-01T09:00:00.000Z"),
      session("awaiting_sync", "2026-09-23T09:00:00.000Z"),
      session("sync_failed", "2026-09-21T09:00:00.000Z"),
      session("in_progress", "2026-09-26T09:00:00.000Z"),
    ];
    // Six days: the confirmed August sitting is not held, and the oldest that is
    // held is the 21st. Getting this from the confirmed one would read as 57 days
    // and make the warning worthless.
    expect(daysHeld(held, now)).toBe(6);
  });

  it("counts a quarantined sitting as held, because only this device has it", () => {
    expect(daysHeld([session("quarantined", "2026-09-23T09:00:00.000Z")], now)).toBe(4);
  });

  it("reads nought rather than a negative number when the iPad's clock is ahead", () => {
    // An iPad restored from a backup can come up with a wall clock in the future.
    expect(daysHeld([session("awaiting_sync", "2026-10-05T09:00:00.000Z")], now)).toBe(0);
  });

  it("ignores a timestamp it cannot read instead of reporting nonsense", () => {
    expect(daysHeld([session("awaiting_sync", "not a date")], now)).toBe(null);
    expect(
      daysHeld([session("awaiting_sync", "not a date"), session("awaiting_sync", "2026-09-25T09:00:00.000Z")], now),
    ).toBe(2);
  });

  it("crosses the panel's threshold on the day it should", () => {
    const threeDaysAgo = new Date(now.getTime() - HELD_TOO_LONG_DAYS * 86_400_000).toISOString();
    expect(daysHeld([session("awaiting_sync", threeDaysAgo)], now)).toBe(HELD_TOO_LONG_DAYS);
    // And a device that has held data for less than that stays quiet, so the
    // warning still means something when it appears.
    expect(daysHeld([session("awaiting_sync", new Date(now.getTime() - 86_400_000).toISOString())], now)).toBeLessThan(
      HELD_TOO_LONG_DAYS,
    );
  });

  it("warns before the browser would delete anything", () => {
    // The threshold has to leave room to act. Equal to the cap would mean the first
    // warning arrives the day the data goes.
    expect(HELD_TOO_LONG_DAYS).toBeLessThan(EVICTION_CAP_DAYS);
  });
});
