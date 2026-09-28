import { useEffect, useMemo, useRef, useState } from "react";
import { doc, onSnapshot, type DocumentData, type Firestore, type Query } from "firebase/firestore";
import { studioFirebase } from "../firebase.js";
import { readErrorMessage } from "./errors.js";
import type { Loadable } from "./types.js";

/**
 * Live Firestore reads as Loadables.
 *
 * Every list and document the screens show is a listener, not a one-off read,
 * so a publish, a restore or a colleague's change appears without anybody
 * pressing reload — the Studio is a shared workspace, and a stale screen in one
 * is how two people end up acting on different facts. A failed listener reports
 * an error with a retry that subscribes again.
 */

export const NOT_CONNECTED = "This copy of the Studio isn’t connected to a study, so there is nothing to load.";

function useRetry(): [number, () => void] {
  const [attempt, setAttempt] = useState(0);
  const retry = useMemo(() => () => setAttempt((a) => a + 1), []);
  return [attempt, retry];
}

/** One document, mapped. `path` null means "nothing to load yet" (stays loading). */
export function useLiveDoc<T>(path: string | null, map: (data: DocumentData) => T, what: string): Loadable<T | null> {
  const fb = studioFirebase();
  const [attempt, retry] = useRetry();
  const mapRef = useRef(map);
  mapRef.current = map;
  const [state, setState] = useState<{ key: string; value: Loadable<T | null> } | null>(null);
  const key = `${path ?? ""}#${attempt}`;

  useEffect(() => {
    if (!fb || !path) return;
    return onSnapshot(
      doc(fb.db, path),
      (snap) => setState({ key, value: { status: "ready", data: snap.exists() ? mapRef.current(snap.data()) : null } }),
      (error) => setState({ key, value: { status: "error", error: readErrorMessage(error, what), retry } }),
    );
  }, [fb, path, key, what, retry]);

  if (!fb) return { status: "error", error: NOT_CONNECTED, retry };
  if (!path || state?.key !== key) return LOADING;
  return state.value;
}

/** A query's documents, mapped and optionally sorted. `make` null means "nothing to load yet". */
export function useLiveQuery<T>(
  make: ((db: Firestore) => Query) | null,
  queryKey: string,
  map: (data: DocumentData, id: string) => T,
  what: string,
  sort?: (a: T, b: T) => number,
): Loadable<T[]> {
  const fb = studioFirebase();
  const [attempt, retry] = useRetry();
  const mapRef = useRef(map);
  mapRef.current = map;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const makeRef = useRef(make);
  makeRef.current = make;
  const [state, setState] = useState<{ key: string; value: Loadable<T[]> } | null>(null);
  const key = `${make ? queryKey : ""}#${attempt}`;
  const enabled = make !== null;

  useEffect(() => {
    const build = makeRef.current;
    if (!fb || !enabled || !build) return;
    return onSnapshot(
      build(fb.db),
      (snap) => {
        const rows = snap.docs.map((d) => mapRef.current(d.data(), d.id));
        if (sortRef.current) rows.sort(sortRef.current);
        setState({ key, value: { status: "ready", data: rows } });
      },
      (error) => setState({ key, value: { status: "error", error: readErrorMessage(error, what), retry } }),
    );
  }, [fb, enabled, key, what, retry]);

  if (!fb) return { status: "error", error: NOT_CONNECTED, retry };
  if (!enabled || state?.key !== key) return LOADING;
  return state.value;
}

export const LOADING = { status: "loading" } as const;
