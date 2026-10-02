/**
 * When a new build is allowed to take over.
 *
 * THE BUG THIS FIXES. `main.tsx` reloaded the page on every `controllerchange`,
 * unconditionally. Two consequences, and the second is the serious one.
 *
 * On a device's FIRST EVER LOAD there is no controller, the service worker
 * installs, takes control, and `controllerchange` fires — so the app reloaded
 * itself moments after opening. A participant who had already typed their code
 * and tapped Start was returned to the start screen with the field empty. No data
 * was lost, because the sitting is in IndexedDB and resumable, but the first
 * person on each iPad had to start again and nothing on screen explained why.
 *
 * And DURING A SITTING, a deploy landing mid-morning did the same thing. The
 * registration is checked every sixty seconds and `onNeedRefresh` applied the
 * update at once, so a child answering question forty was reloaded back to the
 * code screen. In a school hall, with a researcher at the front of the room, that
 * is indistinguishable from the app crashing.
 *
 * SO TWO RULES.
 *
 * Nothing reloads unless a controller was already there when the page loaded.
 * A first install has no stale build to replace, so there is nothing to reload
 * onto and the new worker simply serves the next navigation.
 *
 * And nothing reloads while a sitting is in progress. The update is held and
 * applied when the app is next at a safe point — the start screen, between
 * participants — which is exactly when a device is idle on a table anyway. A
 * build waiting a few minutes for the current child to finish costs nothing; the
 * alternative costs somebody their place in the questionnaire.
 *
 * The policy is a pure function and the wiring around it is four lines, because
 * "when may this page reload itself" is a rule worth being able to read and test
 * without a browser.
 *
 * AND THE GATE DECIDES WHEN A NEW BUILD TAKES OVER, not only when the page
 * reloads onto one (docs/16 R11). The rules above were being applied after the
 * fact: in vite-plugin-pwa's "autoUpdate" mode a new worker took control the
 * moment it installed, and the plugin's own registration code then reloaded the
 * page itself — unconditionally, without asking this gate — so a deploy could
 * still reload a child mid-sitting. Now the worker is built to wait ("prompt"
 * mode), main.tsx reports a waiting build here, and it is told to take over only
 * when no sitting is in progress. Taking over then leads to `tookOver`, and so
 * to the reload, through the same rules as before.
 */

export interface UpdateSituation {
  /** Was a worker already serving this page when it loaded? */
  hadControllerAtLoad: boolean;
  /** Has a new worker taken control since? */
  newBuildTookOver: boolean;
  /** Is somebody part-way through a questionnaire right now? */
  sittingInProgress: boolean;
}

/**
 * Whether to reload onto a new build.
 *
 * Both false-returning cases are the ones that were bugs: a first install has
 * nothing stale to replace, and a sitting in progress is somebody's morning.
 */
export function shouldReloadOnto(situation: UpdateSituation): boolean {
  if (!situation.newBuildTookOver) return false;
  if (!situation.hadControllerAtLoad) return false;
  return !situation.sittingInProgress;
}

/**
 * Whether a downloaded build may be told to take over now.
 *
 * Only when nobody is part-way through a sitting: taking over is what leads to
 * the reload, so it is held back by exactly the rule the reload is.
 */
export function mayActivateWaitingBuild(situation: Pick<UpdateSituation, "sittingInProgress">): boolean {
  return !situation.sittingInProgress;
}

export interface UpdateGate {
  /** A participant has started or resumed a sitting. */
  hold(): void;
  /** The app is back at a screen where reloading costs nobody anything. */
  release(): void;
  /**
   * A new build is installed and waiting. `activate` tells it to take over; it
   * is called now if that is safe, otherwise at the next `release`. Reporting
   * again replaces the earlier `activate`, so only the newest build is applied.
   */
  buildWaiting(activate: () => void): void;
  /** A new build has taken control of this page. */
  tookOver(): void;
  /** Whether a build is waiting for the current sitting to finish. */
  waiting(): boolean;
}

/**
 * The gate itself. `reload` and `hadControllerAtLoad` are injected so the whole
 * thing can be exercised without a service worker or a real page.
 */
export function updateGate(options: { hadControllerAtLoad: boolean; reload: () => void }): UpdateGate {
  let newBuildTookOver = false;
  let sittingInProgress = false;
  let reloaded = false;
  let pendingActivation: (() => void) | null = null;

  const apply = () => {
    if (reloaded) return;
    if (!shouldReloadOnto({ ...options, newBuildTookOver, sittingInProgress })) return;
    reloaded = true;
    options.reload();
  };

  const activate = () => {
    if (!pendingActivation || !mayActivateWaitingBuild({ sittingInProgress })) return;
    const go = pendingActivation;
    pendingActivation = null;
    go();
  };

  return {
    hold() {
      sittingInProgress = true;
    },
    release() {
      sittingInProgress = false;
      activate();
      apply();
    },
    buildWaiting(next) {
      pendingActivation = next;
      activate();
    },
    tookOver() {
      newBuildTookOver = true;
      apply();
    },
    waiting() {
      return pendingActivation !== null || (newBuildTookOver && !reloaded);
    },
  };
}

/**
 * The one the app uses.
 *
 * `navigator.serviceWorker.controller` is read at module load, before any new
 * worker can take over — the only moment the answer is meaningful.
 */
export const updates: UpdateGate = updateGate({
  hadControllerAtLoad: typeof navigator !== "undefined" && Boolean(navigator.serviceWorker?.controller),
  reload: () => location.reload(),
});
