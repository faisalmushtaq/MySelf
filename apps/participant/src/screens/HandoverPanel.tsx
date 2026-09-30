import { passphraseComplaint } from "@myself/store";
import { forgetConfirmedSessions, type Enrolment, type StoredSessionCounts } from "../lib/db.js";
import { syncAvailable } from "../lib/device.js";
import { EVICTION_CAP_DAYS, HELD_TOO_LONG_DAYS, type Durability } from "../lib/durability.js";
import { buildSealedExport, downloadExport } from "../lib/export.js";
import { readableBytes, type Space } from "../lib/space.js";

/**
 * The researcher's panel on the start screen: what this iPad is holding, and the
 * three things to do about it — sync, export to an encrypted file, and clear
 * what the study has already confirmed.
 *
 * Opened by five taps on the build line (see `handoverTaps` in App), because the
 * device spends its day in participants' hands. Every value it shows and every
 * piece of state it changes belongs to App, so the panel stays open, and keeps
 * its passphrase, across the sittings in between.
 */
export interface HandoverPanelProps {
  counts: StoredSessionCounts;
  space: Space | null;
  durability: Durability | null;
  heldDays: number | null;
  online: boolean;
  syncBusy: boolean;
  /** Send the completed sittings now, whatever the back-off says. */
  onSync: () => void;
  device: Enrolment | null;
  /** The study passphrase as typed. Never stored. */
  passphrase: string;
  onPassphraseChange: (passphrase: string) => void;
  /** Say what an export or a clear just did, below the buttons. */
  onNote: (note: string) => void;
  /** Re-read what the device holds, once confirmed sittings are cleared. */
  onCleared: () => Promise<void>;
  syncNote: string | null;
  handoverNote: string | null;
}

export function HandoverPanel({
  counts,
  space,
  durability,
  heldDays,
  online,
  syncBusy,
  onSync,
  device,
  passphrase,
  onPassphraseChange,
  onNote,
  onCleared,
  syncNote,
  handoverNote,
}: HandoverPanelProps) {
  return (
    <div className="handover">
      <h2>Handover</h2>
      {/*
        Room left, before a write fails rather than after.
        A failed write is handled — the survey stops and asks for staff — but
        that is a recovery, and swapping an iPad between participants costs
        nothing. Advisory, because Safari's numbers are.
      */}
      {space?.known && (
        <p className={space.low ? "hint warn" : "hint"}>
          {space.low
            ? `Only about ${readableBytes(space.remaining)} of room left on this iPad — use another one for the next participant if you can. Nothing already answered is at risk.`
            : `About ${readableBytes(space.remaining)} of room left, holding ${readableBytes(space.used)}.`}
        </p>
      )}
      {/*
        The eviction risk, stated plainly, on the panel a researcher opens
        when deciding whether a device can go back in the cupboard. See
        `lib/durability.ts` for why this is not a theoretical concern on an
        iPad. The held-for line is the part that turns it into a decision:
        "holding Monday's data since Monday" is actionable, a count is not.
      */}
      {durability && (durability.atRisk || (heldDays !== null && heldDays >= HELD_TOO_LONG_DAYS)) && (
        <p className="hint warn">
          {durability.atRisk
            ? `This iPad is running MySelf as a Safari tab, so its saved data will be deleted after ${EVICTION_CAP_DAYS} days without the site being opened. Add MySelf to the Home Screen and open it from there, and that stops applying.`
            : "This iPad's storage is protected from being cleared by the browser."}
          {heldDays !== null && heldDays >= HELD_TOO_LONG_DAYS
            ? ` It has been holding data the study has not confirmed for ${heldDays} day${heldDays === 1 ? "" : "s"} — sync it today.`
            : ""}
        </p>
      )}
      <p className="hint">
        {counts.awaitingSync + counts.syncFailed} completed session{counts.awaitingSync + counts.syncFailed === 1 ? "" : "s"} awaiting upload, {counts.syncedVerified} confirmed by the study, {counts.quarantined} needing review, and {counts.inProgress} unfinished on this device. A sitting stays here until the study has confirmed it stored every event this device sent.
      </p>
      <div className="handover-actions">
        <button
          type="button"
          className="secondary"
          disabled={!online || syncBusy || counts.awaitingSync + counts.syncFailed === 0}
          onClick={() => onSync()}
        >
          {syncBusy ? "Synchronising…" : "Sync completed sessions"}
        </button>
      </div>
      {device && (
        <p className="hint">
          This iPad is <strong>{device.deviceId}</strong>, since {device.firstSyncedAt.slice(0, 10)}. It chose
          that itself on first launch, so it works with no network from the start.{" "}
          {syncAvailable
            ? "Sittings upload by themselves whenever it has a connection; nothing needs setting up."
            : "This build has no study configured, so everything stays on this device."}
        </p>
      )}
      {/*
        The passphrase is the STUDY's, not this device's, so a researcher
        with six iPads on a table types one phrase six times rather than
        keeping six secrets — and the researcher view needs one phrase to
        read whatever arrives. Never stored here.
      */}
      <label className="field">
        <span className="field-label">Study passphrase, to encrypt the file</span>
        <input
          className="text-input"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(event) => onPassphraseChange(event.target.value)}
        />
      </label>
      <div className="handover-actions">
        <button
          type="button"
          className="secondary"
          disabled={counts.completed === 0 || passphraseComplaint(passphrase) !== null}
          title={passphraseComplaint(passphrase) ?? undefined}
          onClick={() => {
            void (async () => {
              try {
                const { envelope } = await buildSealedExport(passphrase);
                downloadExport(envelope);
                onNote(
                  `${envelope.sittings} session${envelope.sittings === 1 ? "" : "s"} written, encrypted. Keep the sitting${envelope.sittings === 1 ? "" : "s"} on this device until the file is stored and checked.`,
                );
              } catch (error) {
                onNote(error instanceof Error ? error.message : "Could not write the file.");
              }
            })();
          }}
        >
          Export completed sessions
        </button>
        <button
          type="button"
          className="secondary"
          disabled={counts.completed + counts.inProgress === 0 || passphraseComplaint(passphrase) !== null}
          title={passphraseComplaint(passphrase) ?? undefined}
          onClick={() => {
            void (async () => {
              try {
                const { envelope } = await buildSealedExport(passphrase, { includeInProgress: true });
                downloadExport(envelope, "device-all");
                onNote(
                  `${envelope.sittings} session${envelope.sittings === 1 ? "" : "s"} written, encrypted, unfinished included.`,
                );
              } catch (error) {
                onNote(error instanceof Error ? error.message : "Could not write the file.");
              }
            })();
          }}
        >
          Include unfinished
        </button>
      </div>
      {passphrase.length > 0 && passphraseComplaint(passphrase) && (
        <p className="hint">{passphraseComplaint(passphrase)}</p>
      )}
      <div className="handover-actions">
        {/*
          The only delete in the app, and it cannot reach an unconfirmed
          sitting. `forgetConfirmedSessions` selects on a stored receipt
          whose event count matches what is on the device, so there is no
          version of this button that loses data — which is why it can sit
          next to the export rather than behind a second confirmation
          nobody reads.

          It matters because the alternative is deleting the app or
          clearing Safari's data, and that destroys the device key along
          with it: every sitting not yet handed over becomes permanently
          unreadable.
        */}
        <button
          type="button"
          className="secondary"
          disabled={counts.syncedVerified === 0}
          onClick={() => {
            void (async () => {
              const erased = await forgetConfirmedSessions();
              onNote(
                erased.sessions === 0
                  ? "Nothing to clear — no sitting on this device has been confirmed by the study yet."
                  : `${erased.sessions} confirmed sitting${erased.sessions === 1 ? "" : "s"} cleared from this device. ${counts.awaitingSync + counts.syncFailed + counts.quarantined + counts.inProgress} still held here.`,
              );
              await onCleared();
            })();
          }}
        >
          Clear {counts.syncedVerified} confirmed sitting{counts.syncedVerified === 1 ? "" : "s"}
        </button>
      </div>
      {syncNote && <p className="hint">{syncNote}</p>}
      {handoverNote && <p className="hint">{handoverNote}</p>}
    </div>
  );
}
