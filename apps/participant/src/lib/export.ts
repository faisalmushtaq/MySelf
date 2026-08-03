import { db, deviceKey } from "./db.js";
import { unseal } from "./crypto.js";

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
 * The file is plaintext responses and must be treated as such: it goes to
 * approved storage, not a personal folder, and the device copy is only deleted
 * once the transfer has been confirmed.
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
      complete: row.state === "completed_locally",
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

/** Offer the export as a download, named so a folder of them sorts by date. */
export function downloadExport(data: DeviceExport, deviceLabel = "device"): void {
  const stamp = data.exportedAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `myself_${deviceLabel}_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: Safari has not necessarily started the download
  // by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
