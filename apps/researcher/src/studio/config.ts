/**
 * Reading the Studio's build-time configuration.
 *
 * Pure, so the rules for what counts as "configured" can be tested without a
 * browser: a half-filled Firebase config is treated as no config at all, since
 * an app that initialises against a project with no API key fails later, and
 * somewhere much harder to explain.
 */

export type FirebaseWebConfig = Record<string, string>;

/** The Firebase web config, or null when this build was not pointed at a project. */
export function parseFirebaseConfig(raw: string): FirebaseWebConfig | null {
  try {
    const parsed = JSON.parse(raw || "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const config = parsed as Record<string, unknown>;
    if (typeof config["apiKey"] !== "string" || !config["apiKey"]) return null;
    if (typeof config["projectId"] !== "string" || !config["projectId"]) return null;
    const out: FirebaseWebConfig = {};
    for (const [key, value] of Object.entries(config)) if (typeof value === "string") out[key] = value;
    return out;
  } catch {
    return null;
  }
}

export interface EmulatorHost {
  host: string;
  port: number;
}

export interface EmulatorConfig {
  /** e.g. "http://127.0.0.1:9099" — the Auth emulator takes a URL. */
  auth: string | null;
  firestore: EmulatorHost | null;
  functions: EmulatorHost | null;
}

function hostOf(value: unknown): EmulatorHost | null {
  if (!value || typeof value !== "object") return null;
  const { host, port } = value as { host?: unknown; port?: unknown };
  if (typeof host !== "string" || !host) return null;
  const n = typeof port === "string" ? Number(port) : port;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return { host, port: n };
}

/**
 * The emulators to connect to, or null for the real project.
 *
 * Refuses anything that is not plainly an emulator address on this machine:
 * the test sign-in path exists only when this returns non-null, and it must
 * never be switched on by a config that points somewhere real.
 */
export function parseEmulators(raw: string): EmulatorConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as { auth?: unknown; firestore?: unknown; functions?: unknown };
  const auth = typeof p.auth === "string" && isLocalUrl(p.auth) ? p.auth : null;
  const firestore = hostOf(p.firestore);
  const functions = hostOf(p.functions);
  if (firestore && !isLocalHost(firestore.host)) return null;
  if (functions && !isLocalHost(functions.host)) return null;
  if (!auth && !firestore && !functions) return null;
  return { auth, firestore, functions };
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
}

function isLocalUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
