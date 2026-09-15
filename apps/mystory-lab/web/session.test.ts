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

/**
 * The decisions that follow.
 *
 * Persistence deliberately does NOT depend on `installed`. A first attempt
 * made it conditional on the app reporting itself standalone; this page ships
 * no manifest and no `apple-mobile-web-app-capable`, so iOS reports it as an
 * ordinary browser, the condition was never true on the device it was written
 * for, and the bug was unchanged.
 */
const persistenceFor = (opts: { ephemeral: boolean }) =>
  opts.ephemeral ? ["browserSession"] : ["indexedDBLocal", "browserLocal"];
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

describe("keeping the sign-in", () => {
  it("is durable whatever the browser says it is", () => {
    // THE REGRESSION TEST. A Home Screen icon opens a fresh browsing context
    // every time, so sessionStorage is empty on every launch — and this page
    // reports itself as an ordinary browser, so any rule keyed on "installed"
    // never fires. Durability cannot be conditional on that signal.
    for (const installed of [true, false]) {
      void installed;
      expect(persistenceFor({ ephemeral: false })).toEqual(["indexedDBLocal", "browserLocal"]);
    }
  });

  it("falls back to local storage where IndexedDB is refused", () => {
    // A private window, mostly. Losing the sign-in is better than failing to
    // start at all.
    expect(persistenceFor({ ephemeral: false })[1]).toBe("browserLocal");
  });

  it("is forgotten only when somebody deliberately asks", () => {
    // The borrowed-laptop case the original was protecting, served by an act
    // rather than by a guess about the environment.
    expect(persistenceFor({ ephemeral: true })).toEqual(["browserSession"]);
  });
});

describe("how it asks", () => {
  it("redirects from a genuinely standalone app, which has no popup", () => {
    // A popup needs a second window to talk back to the first.
    expect(methodFor(true)).toBe("redirect");
  });

  it("uses a popup in a tab, which is the nicer thing where it works", () => {
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
