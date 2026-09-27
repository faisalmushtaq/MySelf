/**
 * How much room this iPad has left.
 *
 * WHY BOTHER, when a failed write is already handled. Because the handled version
 * stops a child mid-sitting and fetches a member of staff, and that is a recovery
 * rather than an outcome anybody wants. A device that is nearly full is knowable
 * before a participant ever touches it — at handover, on the panel the operator is
 * already looking at — and swapping an iPad between participants costs nothing.
 *
 * THE NUMBERS ARE ADVISORY AND THAT IS STATED, because Safari's are. iOS reports a
 * quota derived from free disk and will happily say a gigabyte is available on a
 * device that starts refusing writes sooner, and `estimate()` is absent entirely in
 * some contexts. So this never gates anything: a low reading is a suggestion to swap
 * devices, and the real protection is still refusing to continue after a write fails.
 */

export interface Space {
  /** Bytes this origin has used, as the browser reports it. */
  used: number;
  /** Bytes it believes are available in total. */
  quota: number;
  remaining: number;
  /** Whether the browser would tell us anything at all. */
  known: boolean;
  /**
   * Whether the operator should think about swapping devices.
   *
   * A full YBM sitting is about 54 kB, so even a very cautious margin is a few
   * megabytes. Ten is roughly two hundred sittings of headroom: far more than a
   * school day needs, and low enough that it fires before anything is at risk.
   */
  low: boolean;
}

export const LOW_SPACE_BYTES = 10 * 1024 * 1024;

export async function deviceSpace(): Promise<Space> {
  const unknown: Space = { used: 0, quota: 0, remaining: 0, known: false, low: false };
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return unknown;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage !== "number" || typeof quota !== "number" || quota <= 0) return unknown;
    const remaining = Math.max(0, quota - usage);
    return { used: usage, quota, remaining, known: true, low: remaining < LOW_SPACE_BYTES };
  } catch {
    // A browser that refuses to say is not a browser that is out of space.
    return unknown;
  }
}

/** Bytes as an operator reads them, not as a computer stores them. */
export function readableBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}
