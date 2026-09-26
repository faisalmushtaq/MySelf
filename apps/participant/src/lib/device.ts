import { deviceCredential } from "./identity.js";

/**
 * Where this device sends its sittings, and what it presents to do so.
 *
 * NO AUTH SDK. An earlier version signed the device in to Firebase anonymously,
 * which worked but cost three things that matter here: a network round trip before
 * a device had any identity at all, a project-level switch somebody had to find in
 * a console, and the whole Firebase Auth bundle inside an app whose first
 * requirement is to run in a hall with no signal.
 *
 * The device issues its own credential instead, at first launch, offline — see
 * `identity.ts` for why that is still trustworthy. All this module does is decide
 * where to post and hand over the credential to post with.
 *
 * NONE OF THE CONFIGURATION IS SECRET, and it is baked in at build time rather
 * than typed into the page so that the survey is not a place where somebody can
 * point a child's answers at a host of their choosing.
 */

declare const __SITTINGS_URL__: string;

export interface DeviceIdentity {
  /** The installation id the study files this device's sittings under. */
  deviceId: string;
}

export interface SyncTarget {
  /** Where `saveSitting` answers. */
  url: string;
  /** `Authorization: Device <installId>.<secret>` */
  credential: string;
  installId: string;
}

/**
 * Whether this build can reach a study at all.
 *
 * False for the public preview, which is deliberately a survey that stores
 * everything on the device and sends nothing anywhere. The app says so rather than
 * queueing uploads that could never happen.
 */
export const syncAvailable = Boolean(__SITTINGS_URL__);

/**
 * Who this iPad is, creating the identity if this is its first launch.
 *
 * Never fails for want of a network, which is the point — a device unboxed in a
 * school hall with no signal knows what it is before the first participant
 * touches it, and every sitting it records from then on is attributable.
 */
export async function currentDevice(): Promise<DeviceIdentity> {
  return { deviceId: (await deviceCredential()).installId };
}

export async function syncTarget(): Promise<SyncTarget | null> {
  if (!syncAvailable) return null;
  const { installId, secret } = await deviceCredential();
  return { url: __SITTINGS_URL__, credential: `Device ${installId}.${secret}`, installId };
}
