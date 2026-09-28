import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Dialog } from "./ui/dialog.js";
import { Button, Notice } from "./ui/kit.js";
import { formatRoute, isStudioHash, parseHash, samePage, type Route } from "./route.js";

export * from "./route.js";

/**
 * The React side of the hash router: the current route, navigation, links, and
 * a guard that stops a person leaving a survey with work that has not been
 * saved yet.
 *
 * Kept as a tiny module-level store rather than a context so that anything —
 * the editor's outline selecting a question, a toast's action — can navigate
 * without being handed a function, and so every reader agrees on the route in
 * the same render.
 */

const NAV_EVENT = "studio:navigate";

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

const currentHash = () => window.location.hash;

let routeCache: { hash: string; route: Route } | null = null;

function routeOf(hash: string): Route {
  if (routeCache?.hash !== hash) routeCache = { hash, route: parseHash(hash) };
  return routeCache.route;
}

/** The current route. Re-renders on every change of address. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, () => "#/");
  return routeOf(hash);
}

// ── Guards ────────────────────────────────────────────────────────────────

export interface NavigationBlocker {
  /** Whether leaving for `next` needs a person to confirm. Checked at the moment of leaving. */
  blocks: (next: Route | null) => boolean;
  /** Offered as "Save and leave". Resolves true when everything is saved. */
  save?: () => Promise<boolean>;
  /** Why saving is not possible now (offline, a conflict), shown instead of "Save and leave". */
  cannotSave?: () => string | null;
}

const blockers = new Set<NavigationBlocker>();

interface Pending {
  /** Where to go: a Studio route, a whole hash (leaving the Studio), or something to do (signing out). */
  target: Route | string | (() => void);
  replace: boolean;
  blocker: NavigationBlocker;
}

let pending: Pending | null = null;
const pendingListeners = new Set<() => void>();

function setPending(next: Pending | null) {
  pending = next;
  for (const l of pendingListeners) l();
}

function blockerFor(next: Route | null): NavigationBlocker | null {
  for (const b of blockers) if (b.blocks(next)) return b;
  return null;
}

/** The last address this router accepted, so a refused back-button press can be put back. */
let accepted: string | null = null;

function go(target: Route | string, replace: boolean) {
  const hash = typeof target === "string" ? target : formatRoute(target);
  if (hash === window.location.hash) return;
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = hash;
    window.history.replaceState(window.history.state, "", url);
    accepted = window.location.hash;
    window.dispatchEvent(new Event(NAV_EVENT));
  } else {
    // Recorded as the browser normalises it ("#" reads back as ""), before the
    // hashchange event, so the guard recognises this change as its own.
    window.location.hash = hash;
    accepted = window.location.hash;
  }
}

/**
 * Go somewhere in the Studio. Returns false when a guard stopped it to ask
 * first; the navigation then happens (or not) when the person answers.
 */
export function navigate(to: Route, options: { replace?: boolean } = {}): boolean {
  const current = routeOf(window.location.hash);
  const blocker = samePage(current, to) ? null : blockerFor(to);
  if (blocker) {
    setPending({ target: to, replace: options.replace ?? false, blocker });
    return false;
  }
  go(to, options.replace ?? false);
  return true;
}

/**
 * Do something that ends the survey session — signing out — through the same
 * guard, so unsaved work is never dropped without the question being asked.
 */
export function guardedAction(run: () => void): boolean {
  const blocker = blockerFor(null);
  if (blocker) {
    setPending({ target: run, replace: false, blocker });
    return false;
  }
  run();
  return true;
}

/** Leave the Studio for the researcher view, through the same guard. */
export function leaveStudio(): boolean {
  const blocker = blockerFor(null);
  if (blocker) {
    setPending({ target: "", replace: false, blocker });
    return false;
  }
  go("#", false);
  return true;
}

/**
 * Ask before leaving while `when` is true. Also covers closing or reloading the
 * tab (the browser's own prompt — its wording cannot be changed) and the back
 * button (the address is put back while the question is asked).
 */
export function useNavigationGuard(when: boolean, blocker: Omit<NavigationBlocker, "blocks"> & { blocks?: (next: Route | null) => boolean }) {
  const ref = useRef(blocker);
  ref.current = blocker;
  const whenRef = useRef(when);
  whenRef.current = when;

  useEffect(() => {
    const b: NavigationBlocker = {
      blocks: (next) => whenRef.current && (ref.current.blocks ? ref.current.blocks(next) : true),
      save: () => ref.current.save?.() ?? Promise.resolve(false),
      cannotSave: () => ref.current.cannotSave?.() ?? null,
    };
    blockers.add(b);
    return () => {
      blockers.delete(b);
      if (pending?.blocker === b) setPending(null);
    };
  }, []);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Some browsers still need returnValue set to show their prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);
}

/**
 * Watches for address changes the router did not make (back, forward, a typed
 * address). A guarded one is undone by pushing the previous address back, and
 * the question is asked.
 */
function useHashGuard() {
  useEffect(() => {
    accepted = window.location.hash;
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash === accepted) return;
      const previous = accepted;
      const next = isStudioHash(hash) ? routeOf(hash) : null;
      const prevRoute = previous !== null && isStudioHash(previous) ? routeOf(previous) : null;
      const blocker = prevRoute && next && samePage(prevRoute, next) ? null : blockerFor(next);
      if (blocker && previous !== null) {
        const url = new URL(window.location.href);
        url.hash = previous;
        window.history.pushState(window.history.state, "", url);
        window.dispatchEvent(new Event(NAV_EVENT));
        setPending({ target: next ?? hash, replace: false, blocker });
        return;
      }
      accepted = hash;
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
}

/** The "Leave without saving?" question, rendered once near the root. */
export function NavigationPrompt() {
  useHashGuard();
  const current = useSyncExternalStore(
    (l) => {
      pendingListeners.add(l);
      return () => pendingListeners.delete(l);
    },
    () => pending,
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setFailed(null);
    setBusy(false);
  }, [current]);

  if (!current) return null;
  const why = current.blocker.cannotSave?.() ?? null;
  const canSave = !!current.blocker.save && !why;

  const proceed = () => {
    const { target, replace } = current;
    setPending(null);
    if (typeof target === "function") target();
    else go(target, replace);
  };

  return (
    <Dialog
      title="Leave without saving?"
      onClose={() => setPending(null)}
      dismissable={!busy}
      initialFocus=".stp-leave-stay"
      footer={
        <>
          <Button variant="secondary" className="stp-leave-stay" onClick={() => setPending(null)} disabled={busy}>
            Stay here
          </Button>
          <Button variant="danger" onClick={proceed} disabled={busy}>
            Leave without saving
          </Button>
          {canSave ? (
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                setBusy(true);
                setFailed(null);
                void current.blocker.save!().then((ok) => {
                  setBusy(false);
                  if (ok) proceed();
                  else setFailed("The draft couldn’t be saved, so you’re still here. Your changes are safe in this tab.");
                });
              }}
            >
              Save and leave
            </Button>
          ) : null}
        </>
      }
    >
      <p className="stp-flush">
        Your latest changes to this survey haven&rsquo;t been saved yet. If you leave now, this tab keeps a copy and
        offers it back the next time you open the survey here — but nobody else will see them.
      </p>
      {why ? (
        <div className="stp-gap-top">
          <Notice tone="warn">{why}</Notice>
        </div>
      ) : null}
      {failed ? (
        <div className="stp-gap-top">
          <Notice tone="error">{failed}</Notice>
        </div>
      ) : null}
    </Dialog>
  );
}

// ── Links and helpers ─────────────────────────────────────────────────────

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: Route;
  replace?: boolean;
  children: ReactNode;
}

/** A real link (it can be opened in a new tab and copied), navigated through the guard. */
export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  const href = formatRoute(to);
  return (
    <a
      href={href}
      onClick={(e: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, replace ? { replace } : {});
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/**
 * The question selected on the editor or preview page (`?q=`), and a setter
 * that changes it without adding to the browser history — clicking through
 * twenty questions should not take twenty presses of Back to undo.
 */
export function useSelectedQuestion(): [string | null, (itemKey: string | null) => void] {
  const route = useRoute();
  const q = route.name === "survey" || route.name === "playground" ? route.q : null;
  const set = useCallback((itemKey: string | null) => {
    const now = routeOf(window.location.hash);
    if (now.name !== "survey" && now.name !== "playground") return;
    if ((now.q ?? null) === itemKey) return;
    navigate({ ...now, q: itemKey }, { replace: true });
  }, []);
  return useMemo(() => [q, set], [q, set]);
}
