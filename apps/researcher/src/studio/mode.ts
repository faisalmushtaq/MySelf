import { createContext, useContext } from "react";

/**
 * Whether the screens are running in the playground.
 *
 * The playground shows the live survey in the real editor with nothing saved.
 * The draft editor it passes down is in memory, but a hook that writes on its
 * own (presence) would otherwise write against the real survey of the same ID
 * whenever the person happens to be signed in. Hooks that write check this and
 * do nothing; the editor can check it too (e.g. to hide publishing).
 */
export const PlaygroundMode = createContext(false);

export function usePlaygroundMode(): boolean {
  return useContext(PlaygroundMode);
}
