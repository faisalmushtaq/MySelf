import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserSessionPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
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
 * Sign-in is scoped to the tab. Someone demonstrating the module on a borrowed
 * machine should not leave an account signed in behind them.
 */

declare const __FIREBASE_CONFIG__: string;

export interface Session {
  /** Configured at build time; without it the page is mock-only. */
  readonly available: boolean;
  readonly user: User | null;
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

class FirebaseSession implements Session {
  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private listeners: ((user: User | null) => void)[] = [];
  user: User | null = null;

  readonly available = true;

  constructor(config: Record<string, string>) {
    this.app = initializeApp(config);
    this.auth = getAuth(this.app);
    void setPersistence(this.auth, browserSessionPersistence);
    onAuthStateChanged(this.auth, (user) => {
      this.user = user;
      for (const listener of this.listeners) listener(user);
    });
  }

  async signIn(): Promise<void> {
    await signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  async signOut(): Promise<void> {
    await signOut(this.auth);
  }

  async token(): Promise<string | null> {
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
