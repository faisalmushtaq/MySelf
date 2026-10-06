import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  extractDraft,
  importedReleases,
  lockVouchers,
  type LibraryCatalogueResponse,
  type LibraryModuleResponse,
  type LibraryModuleSummary,
  type LockedOptions,
  type StudioDraft,
} from "@myself/studio";
import { useStudy } from "../router.js";
import { studio } from "./callables.js";
import { loadRelease, ReleaseLoadError, type LoadedRelease } from "./releases.js";
import type { Loadable } from "./types.js";

/**
 * The item library's reads (D-57, docs/16 §12): the shelves, a saved module
 * at one of its versions, and published versions of any study's surveys.
 *
 * The shelves come from functions (the rules keep `studioLibrary` closed to
 * browsers, and the catalogue of every study's surveys is only listed for the
 * project's Studio members). Several panels ask for the same answers at once
 * — the drawer, the update notices, the inspector's "Copied from" — so each
 * answer is fetched once and shared, and fetched again after anything is saved
 * to the library, so a notice for a module's new version appears without a
 * reload.
 *
 * Published versions are read from their own study's public release store and
 * verified against their hash before anything is taken from them, exactly as
 * the Versions page reads this study's (releases.ts). An unverified release
 * is never browsed, copied from or allowed to vouch for anything.
 */

// ── One answer per question, shared ───────────────────────────────────────

/**
 * Answers in flight or arrived, by key. A failure is not kept, so asking again
 * asks the server again. `invalidate` forgets what can change (the lists, a
 * module's latest version) and tells every reader, which then asks again while
 * still showing what it had: a notice does not blink out while the list is
 * re-read. A module at a numbered version never changes (versions are
 * immutable), so that is kept.
 */
export class LibraryCache {
  private readonly entries = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const promise = load();
    this.entries.set(key, promise);
    promise.catch(() => {
      if (this.entries.get(key) === promise) this.entries.delete(key);
    });
    return promise;
  }

  /** Forget one answer (a retry after a failure, which is never kept anyway). */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** Forget every answer that can change, and ask the readers to read again. */
  invalidate(): void {
    for (const key of [...this.entries.keys()]) if (!FIXED.test(key)) this.entries.delete(key);
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly version = (): number => this.generation;
}

/** A module at a numbered version: immutable, so never forgotten. */
const FIXED = /^module\|[^|]+\|[^|]+\|\d+$/;

export const libraryKeys = {
  catalogue: (study: string) => `catalogue|${study}`,
  modules: (study: string, includeRetired: boolean) => `modules|${study}|${includeRetired ? "all" : "shelf"}`,
  module: (study: string, moduleId: string, version: number | null) => `module|${study}|${moduleId}|${version ?? "latest"}`,
};

const cache = new LibraryCache();

/** After a save or a change to a module: every shelf and notice reads again. */
export function refreshLibrary(): void {
  cache.invalidate();
}

function messageOf(error: unknown, what: string): string {
  return error instanceof Error && error.message ? error.message : `Couldn’t load ${what}. Try again.`;
}

/**
 * One shared answer as a Loadable. `key` null asks nothing (loading). After an
 * invalidation the answer it had stands until the new one arrives.
 */
function useLibraryAnswer<T>(key: string | null, load: () => Promise<T>, what: string): Loadable<T> {
  const generation = useSyncExternalStore(cache.subscribe, cache.version, cache.version);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value: Loadable<T> } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const retry = () => {
      cache.forget(key);
      setAttempt((a) => a + 1);
    };
    cache.get(key, () => loadRef.current()).then(
      (data) => {
        if (live) setState({ key, value: { status: "ready", data } });
      },
      (error: unknown) => {
        if (live) setState({ key, value: { status: "error", error: messageOf(error, what), retry } });
      },
    );
    return () => {
      live = false;
    };
  }, [key, generation, attempt, what]);

  if (key === null || state?.key !== key) return { status: "loading" };
  return state.value;
}

/**
 * Every study's surveys with a published version, for the "Published surveys"
 * shelf and "Copy a published version". Nothing is asked while `enabled` is false.
 */
export function useLibraryCatalogue(enabled = true): Loadable<LibraryCatalogueResponse> {
  const study = useStudy();
  return useLibraryAnswer(enabled ? libraryKeys.catalogue(study) : null, () => studio.libraryCatalogue({}), "the published surveys");
}

/** The saved modules: those on the shelf, or every one (retired too) when asked. Nothing is asked while `enabled` is false. */
export function useLibraryModules(includeRetired = false, enabled = true): Loadable<LibraryModuleSummary[]> {
  const study = useStudy();
  return useLibraryAnswer(
    enabled ? libraryKeys.modules(study, includeRetired) : null,
    () => studio.libraryModules(includeRetired ? { includeRetired: true } : {}).then((r) => r.modules),
    "the saved modules",
  );
}

/** One saved module at a version (its latest when none is given), with its piece and every version's summary. */
export function useLibraryModule(moduleId: string | null, version?: number | null): Loadable<LibraryModuleResponse> {
  const study = useStudy();
  const v = version ?? null;
  return useLibraryAnswer(
    moduleId ? libraryKeys.module(study, moduleId, v) : null,
    () => studio.libraryModule({ moduleId: moduleId!, ...(v !== null ? { version: v } : {}) }),
    "this module",
  );
}

// ── Published versions of any study's surveys ─────────────────────────────

export interface ReleaseRef {
  study: string;
  hash: string;
}

export const releaseRefKey = (ref: ReleaseRef): string => `${ref.study}/${ref.hash}`;

/** One draft per release, however often it is asked for. */
const drafts = new WeakMap<LoadedRelease, StudioDraft>();
function draftOf(release: LoadedRelease): StudioDraft {
  let draft = drafts.get(release);
  if (!draft) {
    draft = extractDraft(release.raw);
    drafts.set(release, draft);
  }
  return draft;
}

export interface ReleaseDrafts {
  /** Each verified release, as the draft it would be edited from, by `study/hash`. */
  drafts: ReadonlyMap<string, StudioDraft>;
  /** Why each release that could not be used was refused, by `study/hash`. */
  errors: ReadonlyMap<string, string>;
  /** Still fetching or verifying. */
  pending: boolean;
  retry: () => void;
}

const EMPTY_DRAFTS: ReadonlyMap<string, StudioDraft> = new Map();
const EMPTY_ERRORS: ReadonlyMap<string, string> = new Map();

/**
 * Several published versions, from any studies, each fetched from its own
 * study's store and verified against its hash (`loadRelease`). One that fails
 * does not hold up the others: it is listed with its reason instead.
 */
export function useReleaseDrafts(refs: readonly ReleaseRef[]): ReleaseDrafts {
  const key = [...new Set(refs.map(releaseRefKey))].sort().join(",");
  const [attempt, setAttempt] = useState(0);
  const retry = useMemo(() => () => setAttempt((a) => a + 1), []);
  const stateKey = `${key}#${attempt}`;
  const [state, setState] = useState<{ key: string; drafts: Map<string, StudioDraft>; errors: Map<string, string> } | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split(",").map((k) => {
      const at = k.indexOf("/");
      return { key: k, study: k.slice(0, at), hash: k.slice(at + 1) };
    });
    void Promise.allSettled(list.map((r) => loadRelease(r.hash, r.study).then(draftOf))).then((results) => {
      if (!live) return;
      const out = new Map<string, StudioDraft>();
      const errors = new Map<string, string>();
      results.forEach((result, i) => {
        const k = list[i]!.key;
        if (result.status === "fulfilled") out.set(k, result.value);
        else
          errors.set(
            k,
            result.reason instanceof ReleaseLoadError ? result.reason.message : "This published version couldn’t be opened, so it hasn’t been used.",
          );
      });
      setState({ key: stateKey, drafts: out, errors });
    });
    return () => {
      live = false;
    };
  }, [key, stateKey]);

  return useMemo(() => {
    if (!key) return { drafts: EMPTY_DRAFTS, errors: EMPTY_ERRORS, pending: false, retry };
    if (state?.key !== stateKey) return { drafts: EMPTY_DRAFTS, errors: EMPTY_ERRORS, pending: true, retry };
    return { drafts: state.drafts, errors: state.errors, pending: false, retry };
  }, [key, state, stateKey, retry]);
}

/** One published version of any study's survey, verified, as a draft to browse and copy from. */
export function useReleaseDraft(ref: ReleaseRef | null): Loadable<StudioDraft> {
  const study = ref?.study ?? null;
  const hash = ref?.hash ?? null;
  const refs = useMemo(() => (study && hash ? [{ study, hash }] : []), [study, hash]);
  const loaded = useReleaseDrafts(refs);
  return useMemo<Loadable<StudioDraft>>(() => {
    if (!study || !hash || loaded.pending) return { status: "loading" };
    const k = releaseRefKey({ study, hash });
    const draft = loaded.drafts.get(k);
    if (draft) return { status: "ready", data: draft };
    return { status: "error", error: loaded.errors.get(k) ?? "This published version couldn’t be opened.", retry: loaded.retry };
  }, [study, hash, loaded]);
}

// ── Vouchers (docs/16 §12.4) ──────────────────────────────────────────────

export interface VoucherSources {
  /** The verified releases the draft copied from, as drafts: what, with the instrument library, vouches for copied locked content. */
  releases: readonly StudioDraft[];
  /** Releases still being fetched and verified: until they are, what they would vouch for is not accepted. */
  pending: boolean;
  /** Releases the draft names that could not be verified, with why; they vouch for nothing. */
  refused: { ref: string; reason: string }[];
  /** Releases past the number one publish reads (MAX_IMPORTED_RELEASES); the server will not read them either. */
  overLimit: number;
}

const NO_REFS: readonly ReleaseRef[] = [];
const NO_RELEASES: readonly StudioDraft[] = [];

/**
 * The editor's side of the vouchers the server applies when the draft is
 * published (docs/16 §12.4): each release the draft names as a source, read
 * from its own study's store and verified against its hash. With the
 * instrument library (`vouchersFor`), they are what lets a copied
 * questionnaire through its locks — so it is accepted here exactly when the
 * server will accept it, never shown as ready and then refused.
 */
export function useVoucherSources(draft: StudioDraft): VoucherSources {
  const named = useMemo(() => {
    try {
      return importedReleases(draft);
    } catch {
      return { releases: [] as ReleaseRef[], overLimit: 0 };
    }
  }, [draft]);
  // The key, not the list, decides whether anything is fetched again: typing
  // elsewhere in the draft makes a new list naming the same releases.
  const key = named.releases.map(releaseRefKey).sort().join(",");
  const refs = useMemo(
    () =>
      key
        ? key.split(",").map((k) => {
            const at = k.indexOf("/");
            return { study: k.slice(0, at), hash: k.slice(at + 1) };
          })
        : NO_REFS,
    [key],
  );
  const loaded = useReleaseDrafts(refs);
  const releases = useMemo(() => (loaded.drafts.size > 0 ? [...loaded.drafts.values()] : NO_RELEASES), [loaded.drafts]);
  return useMemo(
    () => ({
      releases,
      pending: loaded.pending,
      refused: [...loaded.errors].map(([ref, reason]) => ({ ref, reason })),
      overLimit: named.overLimit,
    }),
    [releases, loaded.pending, loaded.errors, named.overLimit],
  );
}

/**
 * What locked content in `draft` may match, for `validateDraft`: the
 * validated questionnaires and the verified releases it copied from, chosen
 * for this draft's copies as the server chooses them (`lockVouchers`). A
 * voucher that cannot be worked out vouches for nothing: the editor then
 * shows the questionnaire as unvouched, which is what the server would say.
 */
export function vouchersFor(releases: readonly StudioDraft[], draft: StudioDraft): LockedOptions {
  try {
    return lockVouchers({ releases: [...releases], library: true, draft });
  } catch {
    return {};
  }
}
