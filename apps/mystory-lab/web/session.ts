import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  getRedirectResult,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

/**
 * Who is asking for a model call.
 *
 * The relay will not make one for an anonymous caller, and that is the point:
 * a spending endpoint open to the web is a bill with an API in front of it.
 * So the page signs somebody in and sends their Firebase ID token, and the
 * function decides from the token whether this is a member of the research
 * team or an enrolled device.
 *
 * NONE OF THIS CONFIGURATION IS SECRET. A Firebase web config is a set of
 * public identifiers — the `apiKey` names a project, it does not authorise
 * anything. What authorises is the signed-in account and the security rules.
 * It is baked in at build time rather than typed into the page so that nobody
 * can point this page at a different project.
 *
 * ── Signing in from the Home Screen ──────────────────────────────────────
 *
 * This worked in Safari and did not work once the page had been added to the
 * Home Screen: sign-in appeared to succeed, and coming back to the app it had
 * never heard of you. Three separate causes, and all three had to be fixed —
 * any one of them on its own reproduces the symptom.
 *
 * A HOME SCREEN WEB APP HAS ITS OWN STORAGE. Since iOS 16.4 it is not a
 * bookmark that opens Safari; it is a separate container with its own cookies,
 * its own IndexedDB and its own local storage. Nothing signed in on one side
 * is visible from the other, which is why it looked like the sign-in had been
 * thrown away when in fact it had landed somewhere else.
 *
 * SO A POPUP CANNOT WORK THERE. `signInWithPopup` needs a second window to
 * talk back to the first. A standalone app has no window model to open one
 * in, so iOS hands the URL to Safari — the sign-in genuinely succeeds, in
 * Safari's container, and the app that asked for it is never told. That is
 * exactly what "it lets me log in and then shows me the sign in thing again"
 * is. Installed, this now REDIRECTS instead: the navigation happens in the
 * app's own web view, so the credential comes back to the container that
 * asked for it. In an ordinary tab the popup is still nicer and still used.
 *
 * AND THE SESSION HAD TO SURVIVE THE APP BEING CLOSED. Persistence was
 * `browserSessionPersistence` — `sessionStorage`, which is emptied when the
 * context goes away. iOS reclaims standalone web apps aggressively, so every
 * return to the Home Screen icon was a fresh context and an empty store: even
 * a credential that HAD landed correctly would have been gone by the time
 * anybody looked. Installed, persistence is now IndexedDB, which survives the
 * app being closed and reopened.
 *
 * The original reason for scoping it to the tab was a good one — somebody
 * demonstrating this on a borrowed laptop should not leave their account
 * behind — and it still holds in a browser tab, where it still applies. An
 * app somebody deliberately installed on their own phone is the case it was
 * never about.
 */

declare const __FIREBASE_CONFIG__: string;

export interface Session {
  /** Configured at build time; without it the page is mock-only. */
  readonly available: boolean;
  readonly user: User | null;
  /**
   * Resolves once a returning redirect has been consumed and the first auth
   * state is known.
   *
   * Anything that asks "is somebody signed in?" at boot has to wait for this.
   * Firebase reports `null` before it has finished restoring, so a page that
   * checked immediately would decide nobody was signed in and show the button
   * again — the same visible bug, arrived at a different way.
   */
  ready(): Promise<void>;
  /**
   * Why a returning sign-in did not complete, if one did not.
   *
   * There is no console on a phone. Without this, a redirect that comes back
   * and fails looks exactly like never having signed in — the button is there
   * again and nothing says why — which is the bug this whole module was just
   * rewritten for, arrived at from the other side.
   */
  trouble(): Promise<string | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** A fresh ID token for the relay, or null when nobody is signed in. */
  token(): Promise<string | null>;
  onChange(listener: (user: User | null) => void): void;
}

function parseConfig(): Record<string, string> | null {
  try {
    const parsed = JSON.parse(__FIREBASE_CONFIG__ || "null") as Record<string, string> | null;
    return parsed && parsed["apiKey"] && parsed["projectId"] ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether this is running as an app somebody installed, rather than a tab.
 *
 * Two ways of asking because iOS answers to the older one: `navigator.standalone`
 * is Apple's, and the display-mode media query is the standard. Either being
 * true means there is no useful popup and no reason to forget the sign-in when
 * the app is closed.
 */
export function isInstalled(): boolean {
  try {
    if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

class FirebaseSession implements Session {
  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private readonly installed = isInstalled();
  private listeners: ((user: User | null) => void)[] = [];
  private readonly settled: Promise<void>;
  private failure: string | null = null;
  user: User | null = null;

  readonly available = true;

  constructor(config: Record<string, string>) {
    this.app = initializeApp(config);

    /**
     * Persistence is chosen HERE, not set afterwards.
     *
     * `setPersistence` is asynchronous, and the old code did not await it —
     * so a sign-in that began before it resolved could be written with
     * whatever persistence Firebase had defaulted to. `initializeAuth` takes
     * the choice up front and there is no window in which it is unset.
     *
     * The list is tried in order: IndexedDB, then local storage for a browser
     * that will not give us IndexedDB (a private window, mostly).
     */
    this.auth = initializeAuth(this.app, {
      persistence: this.installed
        ? [indexedDBLocalPersistence, browserLocalPersistence]
        : [browserSessionPersistence],
    });

    this.settled = new Promise<void>((resolve) => {
      /**
       * Consume a returning redirect before answering anybody.
       *
       * Coming back from Google, the credential is in the URL and is only
       * turned into a signed-in user by this call. It has to happen, and it
       * has to happen before the page concludes anything about who is signed
       * in.
       */
      void getRedirectResult(this.auth)
        .catch((error: unknown) => {
          // Not fatal, and worth seeing: on iOS this is where a cross-origin
          // auth handler fails, and it fails silently otherwise.
          const code = (error as { code?: string }).code ?? "";
          const message = (error as Error).message ?? String(error);
          this.failure = code.includes("missing-initial-state")
            ? "Signing in did not complete because this device would not carry the sign-in between two web addresses. Whoever set this up needs the sign-in handler served from the same address as the app."
            : `Signing in did not finish: ${message}`;
          console.warn("sign-in: could not complete a returning redirect", error);
          return null;
        })
        .finally(() => {
          let first = true;
          onAuthStateChanged(this.auth, (user) => {
            this.user = user;
            for (const listener of this.listeners) listener(user);
            if (first) {
              first = false;
              resolve();
            }
          });
        });
    });
  }

  ready(): Promise<void> {
    return this.settled;
  }

  async trouble(): Promise<string | null> {
    await this.settled;
    // Cleared once somebody is actually signed in: a stale complaint about a
    // redirect that failed an hour ago helps nobody.
    return this.user ? null : this.failure;
  }

  async signIn(): Promise<void> {
    if (this.installed) {
      // The whole app navigates and comes back. Nothing after this runs.
      await signInWithRedirect(this.auth, new GoogleAuthProvider());
      return;
    }
    try {
      await signInWithPopup(this.auth, new GoogleAuthProvider());
    } catch (error) {
      /**
       * A browser that would not give us a popup, in a context that did not
       * look installed.
       *
       * Rather than tell somebody their sign-in failed when the only thing
       * that failed was the manner of asking, fall back to the redirect —
       * which works anywhere.
       */
      const code = (error as { code?: string }).code ?? "";
      const popupTrouble =
        code.includes("popup-blocked") ||
        code.includes("popup-closed-by-user") ||
        code.includes("operation-not-supported") ||
        code.includes("cancelled-popup-request");
      if (!popupTrouble) throw error;
      if (code.includes("popup-closed-by-user")) return;
      await signInWithRedirect(this.auth, new GoogleAuthProvider());
    }
  }

  async signOut(): Promise<void> {
    await signOut(this.auth);
  }

  async token(): Promise<string | null> {
    // Wait for the restore before answering. Asked at boot, this used to
    // return null while Firebase was still reading its own storage.
    await this.settled;
    // Asked for on every call rather than cached: a token lasts an hour and a
    // narrative session can outlast one, and a refusal halfway through an
    // interview would cost the participant the rest of it.
    return this.user ? this.user.getIdToken() : null;
  }

  onChange(listener: (user: User | null) => void): void {
    this.listeners.push(listener);
    listener(this.user);
  }
}

/** What the page gets when no project was configured into this build. */
const unavailable: Session = {
  available: false,
  user: null,
  async ready() {},
  async trouble() {
    return null;
  },
  async signIn() {
    throw new Error("this build has no Firebase project configured, so it cannot sign anybody in");
  },
  async signOut() {},
  async token() {
    return null;
  },
  onChange(listener) {
    listener(null);
  },
};

const config = parseConfig();
export const session: Session = config ? new FirebaseSession(config) : unavailable;
