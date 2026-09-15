import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Signing in from the Home Screen.
 *
 * What is worth testing is not Firebase — it is the two decisions this module
 * makes on the way in, both of which were wrong and both of which fail
 * silently on a phone. Mocking the SDK would test the mock; these test the
 * rules, stated once here and once in the module.
 */

/** The same question `isInstalled` asks, in isolation. */
function installedFrom(env: { standalone?: boolean; displayMode?: boolean }): boolean {
  if (env.standalone === true) return true;
  return env.displayMode === true;
}

/** The decisions that follow from it. */
const persistenceFor = (installed: boolean) =>
  installed ? ["indexedDBLocal", "browserLocal"] : ["browserSession"];
const methodFor = (installed: boolean) => (installed ? "redirect" : "popup");

describe("whether this is an installed app or a tab", () => {
  it("believes Apple's flag, which is how iOS answers", () => {
    expect(installedFrom({ standalone: true })).toBe(true);
  });

  it("believes the standard display-mode query too", () => {
    expect(installedFrom({ displayMode: true })).toBe(true);
  });

  it("treats an ordinary tab as an ordinary tab", () => {
    expect(installedFrom({ standalone: false, displayMode: false })).toBe(false);
  });
});

describe("what an installed app gets", () => {
  it("keeps the sign-in across the app being closed", () => {
    // sessionStorage is emptied when the context goes away, and iOS reclaims
    // standalone web apps constantly — every return to the icon was a fresh
    // context and an empty store.
    expect(persistenceFor(true)).toContain("indexedDBLocal");
    expect(persistenceFor(true)).not.toContain("browserSession");
  });

  it("falls back to local storage where IndexedDB is refused", () => {
    // A private window, mostly. Losing the sign-in is better than failing to
    // start at all.
    expect(persistenceFor(true)).toEqual(["indexedDBLocal", "browserLocal"]);
  });

  it("signs in by redirect, because a standalone app has no popup", () => {
    // A popup needs a second window to talk back to the first. iOS hands the
    // URL to Safari instead: the sign-in succeeds in Safari's container and
    // the app that asked is never told.
    expect(methodFor(true)).toBe("redirect");
  });
});

describe("what a browser tab still gets", () => {
  it("forgets the sign-in when the tab goes, as it always did", () => {
    // The borrowed-laptop case the original was written for, which still
    // holds in a tab and was never about an app somebody installed.
    expect(persistenceFor(false)).toEqual(["browserSession"]);
  });

  it("uses a popup, which is the nicer thing where it works", () => {
    expect(methodFor(false)).toBe("popup");
  });
});

/** The fallback rule, when a popup is refused in something that looked like a tab. */
function shouldFallBackToRedirect(code: string): boolean {
  const trouble =
    code.includes("popup-blocked") ||
    code.includes("popup-closed-by-user") ||
    code.includes("operation-not-supported") ||
    code.includes("cancelled-popup-request");
  if (!trouble) return false;
  return !code.includes("popup-closed-by-user");
}

describe("when a popup is refused", () => {
  it("retries by redirect rather than reporting a failed sign-in", () => {
    // Only the manner of asking failed.
    expect(shouldFallBackToRedirect("auth/popup-blocked")).toBe(true);
    expect(shouldFallBackToRedirect("auth/operation-not-supported-in-this-environment")).toBe(true);
  });

  it("does not drag somebody through a redirect they just cancelled", () => {
    expect(shouldFallBackToRedirect("auth/popup-closed-by-user")).toBe(false);
  });

  it("lets a real failure be a real failure", () => {
    expect(shouldFallBackToRedirect("auth/network-request-failed")).toBe(false);
    expect(shouldFallBackToRedirect("auth/user-disabled")).toBe(false);
  });
});

describe("the auth handler's origin", () => {
  it("is the origin the app is served from", async () => {
    // Sign-in hands off to /__/auth/handler on the authDomain and hands back.
    // Two origins means Safari partitions the storage between them and the
    // handler cannot read the state it just wrote.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../build-hosting.mjs", import.meta.url), "utf8");
    const authDomain = /authDomain:\s*"([^"]+)"/.exec(source)?.[1];
    const projectId = /projectId:\s*"([^"]+)"/.exec(source)?.[1];
    expect(authDomain).toBe(`${projectId}.web.app`);
  });
});

afterEach(() => vi.restoreAllMocks());
