import { db, deviceKey } from "./db.js";
import { unseal } from "./crypto.js";
import { sealExport, type EncryptedEnvelope } from "@myself/store";

/**
 * Handover: taking the sittings off this iPad.
 *
 * Until sync exists, the route from a device to the dataset is a file. This
 * writes it: the append-only event log, decrypted, in exactly the shape the
 * researcher view ingests — no summarising, no scoring, no dropping of events
 * this app happens not to care about. The device is not allowed an opinion
 * about what the record contains; that is what makes a re-ingest years later
 * able to fix a bug in the reader rather than being stuck with its output.
 *
 * THE FILE IS ENCRYPTED UNDER THE STUDY PASSPHRASE. It used to be plaintext, with
 * a comment here asking for it to be treated carefully — which made the device's
 * own AES-GCM storage largely decorative, since the data left by the unlocked
 * door. A handover file crosses a room on a USB stick or an AirDrop and is the
 * copy most likely to end up somewhere nobody planned.
 *
 * Losing the passphrase is recoverable: exporting removes nothing from the
 * device, so a file nobody can open can simply be written again. That is what
 * makes encryption the only format here rather than an option for careful days.
 */

export const EXPORT_FORMAT = "myself.device.export.v1";

export interface DeviceExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  /** Which app wrote it, for when the reader has to be bug-compatible. */
  app: string;
  sessions: {
    sessionId: string;
    studyCode: string;
    releaseKey: string;
    releaseHash: string;
    startedAt: string;
    completedAt?: string;
    complete: boolean;
    events: {
      seq: number;
      type: string;
      itemKey?: string;
      payload?: unknown;
      tWall: string;
      tMono: number;
    }[];
  }[];
}

export interface ExportOptions {
  /** Sittings still in progress are left on the device by default: they are
   *  not finished, and exporting one invites a duplicate when it is. */
  includeInProgress?: boolean;
  appVersion?: string;
}

export async function buildDeviceExport(options: ExportOptions = {}): Promise<DeviceExport> {
  const key = await deviceKey();
  const rows = await db.sessions.toArray();
  const wanted = rows.filter((s) => (options.includeInProgress ? true : s.state !== "in_progress"));

  const sessions: DeviceExport["sessions"] = [];
  for (const row of wanted.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const events = await db.events.where("sessionId").equals(row.sessionId).sortBy("seq");
    const out: DeviceExport["sessions"][number]["events"] = [];
    for (const e of events) {
      let payload: unknown;
      if (e.payload) {
        try {
          payload = await unseal<unknown>(key, e.payload);
        } catch {
          // A payload this device can no longer open is still evidence that
          // the event happened. Record the failure in the log rather than
          // dropping the row and leaving a gap nobody can account for.
          payload = { unreadable: true };
        }
      }
      out.push({
        seq: e.seq,
        type: e.type,
        ...(e.itemKey !== undefined ? { itemKey: e.itemKey } : {}),
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
        tWall: e.tWall,
        tMono: e.tMono,
      });
    }
    sessions.push({
      sessionId: row.sessionId,
      studyCode: row.participantCode,
      releaseKey: row.releaseKey,
      releaseHash: row.releaseHash,
      startedAt: row.startedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      complete: row.state !== "in_progress" && row.state !== "not_started",
      events: out,
    });
  }

  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    app: options.appVersion ?? "myself-participant",
    sessions,
  };
}

/**
 * Offer the export as a download, named so a folder of them sorts by date.
 *
 * Takes an already-sealed envelope rather than sealing here, so that there is no
 * overload of this function that writes a plaintext file — the thing that must
 * not exist is easier to prevent by leaving nowhere to put it.
 */
export function downloadExport(envelope: EncryptedEnvelope, deviceLabel = "device"): void {
  const data = envelope;
  const stamp = data.exportedAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `myself_${deviceLabel}_${stamp}.myself.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: Safari has not necessarily started the download
  // by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Build and seal in one step, which is the only way the app offers a file. */
export async function buildSealedExport(
  passphrase: string,
  options: ExportOptions = {},
): Promise<{ envelope: EncryptedEnvelope; sessionIds: string[] }> {
  const data = await buildDeviceExport(options);
  const envelope = await sealExport(data, passphrase, data.sessions.length);
  return { envelope, sessionIds: data.sessions.map((session) => session.sessionId) };
}
