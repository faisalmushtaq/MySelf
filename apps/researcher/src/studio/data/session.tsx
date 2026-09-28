import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut as fbSignOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { CALLABLES, type SessionRequest, type SessionResponse } from "@myself/studio";
import { studioFirebase } from "../firebase.js";
import { authErrorMessage, toStudioCallError } from "./errors.js";
import type { StudioSession, StudioUser } from "./types.js";

/**
 * Who is signed in, and what the Studio list says they may do.
 *
 * The role comes from the server (`studioSession`), never from the token or
 * the email: the allowlist lives in documents only functions write, and the
 * rules and functions re-read it on every request (docs/16 §5.7). What the
 * browser holds here decides only what to show — a person who edits it gains
 * nothing, because every read and write is checked again where it lands.
 */

type SessionState = Pick<StudioSession, "status" | "user" | "role" | "reason" | "error">;

const UNCONFIGURED: SessionState = { status: "unconfigured", user: null, role: null, reason: null, error: null };
const SIGNED_OUT: SessionState = { status: "signed_out", user: null, role: null, reason: "not_signed_in", error: null };

const SessionContext = createContext<StudioSession | null>(null);

const beforeSignOut = new Set<() => Promise<unknown>>();

/** Run `fn` (while still signed in) when the person signs out. Returns the unregister function. */
export function onBeforeSignOut(fn: () => Promise<unknown>): () => void {
  beforeSignOut.add(fn);
  return () => beforeSignOut.delete(fn);
}

function userOf(u: User): StudioUser {
  return { uid: u.uid, email: u.email, displayName: u.displayName, photoURL: u.photoURL };
}

/** Provides Firebase and the signed-in session to everything under it. */
export function StudioDataProvider({ children }: { children: ReactNode }) {
  const fb = studioFirebase();
  const [state, setState] = useState<SessionState>(
    fb ? { status: "loading", user: null, role: null, reason: null, error: null } : UNCONFIGURED,
  );
  // Answers can arrive out of order (a slow session call from before a sign-out);
  // only the latest request may set the state.
  const seq = useRef(0);
  const userRef = useRef<User | null>(null);

  const resolve = useCallback(
    async (user: User | null, keepShowing: boolean) => {
      const mine = ++seq.current;
      if (!user) {
        setState(SIGNED_OUT);
        return;
      }
      if (!keepShowing) setState({ status: "loading", user: userOf(user), role: null, reason: null, error: null });
      try {
        const call = httpsCallable<SessionRequest, SessionResponse>(fb!.fns, CALLABLES.session);
        const { data } = await call({});
        if (mine !== seq.current) return;
        setState(
          data.role
            ? { status: "ready", user: userOf(user), role: data.role, reason: null, error: null }
            : { status: "unauthorised", user: userOf(user), role: null, reason: data.reason ?? "not_listed", error: null },
        );
      } catch (error) {
        if (mine !== seq.current) return;
        const failed: SessionState = {
          status: "error",
          user: userOf(user),
          role: null,
          reason: null,
          error: `Couldn’t check your access to the Studio. ${toStudioCallError(error).message}`,
        };
        // A background re-check (the draft editor asks after a refused save)
        // that merely failed to reach the server must not replace the whole
        // Studio — and the editor with it — with an error page. The role
        // already shown stands; the rules still check every request.
        setState((s) => (keepShowing && s.status === "ready" && s.user?.uid === user.uid ? s : failed));
      }
    },
    [fb],
  );

  useEffect(() => {
    if (!fb) return;
    return onAuthStateChanged(fb.auth, (user) => {
      userRef.current = user;
      void resolve(user, false);
    });
  }, [fb, resolve]);

  const signIn = useCallback(async () => {
    if (!fb) return;
    const provider = new GoogleAuthProvider();
    // Always ask which account: the person most likely to need this is the one
    // signed in to Google with a personal account who meant to use their work one.
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(fb.auth, provider);
    } catch (error) {
      const message = authErrorMessage(error);
      if (message) setState((s) => ({ ...s, status: s.user ? s.status : "signed_out", error: message }));
    }
  }, [fb]);

  const signOut = useCallback(async () => {
    if (!fb) return;
    // Tidy-ups that need the person still signed in (removing their presence
    // document, which the rules only let its owner delete). Bounded, so a
    // slow network never keeps somebody signed in who asked to leave.
    const pending = [...beforeSignOut].map((fn) => fn().catch(() => undefined));
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 1500))]);
    await fbSignOut(fb.auth);
  }, [fb]);

  const refresh = useCallback(async () => {
    const user = userRef.current;
    if (!user) return;
    // Keep the page on screen while asking again, so "Check again" does not
    // flash a loading state over the explanation it is standing on.
    await resolve(user, true);
  }, [resolve]);

  const value = useMemo<StudioSession>(() => ({ ...state, signIn, signOut, refresh }), [state, signIn, signOut, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

const NO_PROVIDER: StudioSession = {
  ...UNCONFIGURED,
  signIn: async () => undefined,
  signOut: async () => undefined,
  refresh: async () => undefined,
};

/**
 * The signed-in session. Outside a StudioDataProvider (a component rendered on
 * its own, in a test) it reports "unconfigured" rather than throwing, as the
 * placeholder this replaced did.
 */
export function useStudioSession(): StudioSession {
  return useContext(SessionContext) ?? NO_PROVIDER;
}

/** The email the rules compare against: Firebase's token email, lower-cased (docs/16 §5.2, layout.ts `studioMember`). */
export function ruleEmail(user: StudioUser | null): string {
  return (user?.email ?? "").toLowerCase();
}
