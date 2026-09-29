import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildBidsExport, buildDemoSessions, buildZip, summarise, wideTable, type Dataset } from "@myself/store";
import { DataTable, downloadCsv } from "./components/DataTable.js";
import { Linkage } from "./components/Linkage.js";
import { ParticipantPanel } from "./components/ParticipantPanel.js";
import { Protocols } from "./components/Protocols.js";
import { Summary } from "./components/Summary.js";
import { buildDatasetWithStore } from "./lib/build.js";
import {
  addSessions,
  aliases,
  assignSession,
  assignments,
  clearAll,
  importExportFile,
  mergeFromStudy,
  storeIdentity,
  storedSessions,
  type ImportReport,
} from "./lib/db.js";
import {
  pullSittings,
  revokeDevice,
  signIn,
  signOutOfStudy,
  studyAvailable,
  watchUser,
  type StudyUser,
} from "./lib/study.js";
import { defaultColumns } from "./lib/filter.js";
import { latestRelease } from "./lib/releases.js";

/**
 * MySelf — researcher view.
 *
 * One dataset, in the browser: every sitting ever imported, summarised at the
 * top, filterable on every column below, and downloadable as a BIDS-style
 * folder. It reads the raw event logs and derives everything else on load, so
 * what is on screen and what comes out of the export are computed by the same
 * code from the same source.
 *
 * It runs entirely locally. There is no server yet, and until there is, this
 * is a laptop tool holding real answers: that is why the storage is per
 * browser-profile, why the demonstration data is obviously labelled, and why
 * clearing everything is one click away.
 */

const STUDY = "YBM-ND2026";

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The newest `reload` started; an older one that finishes after it is dropped. */
let reloadGeneration = 0;

type Tab = "overview" | "table" | "linkage" | "mystory" | "data";

/**
 * MySelf Studio (docs/16) lives at `#/…` addresses on the same page, loaded as
 * its own chunk only when one is opened. Any other address is this view,
 * exactly as before.
 */
const StudioRoot = lazy(() => import("./studio/StudioRoot.js"));

function subscribeToHash(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  // The Studio's router also announces address changes it makes without one.
  window.addEventListener("studio:navigate", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("studio:navigate", listener);
  };
}

export default function App() {
  const inStudio = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.startsWith("#/"),
    () => false,
  );
  if (inStudio) {
    return (
      <Suspense fallback={<p className="working">Opening MySelf Studio…</p>}>
        <StudioRoot />
      </Suspense>
    );
  }
  return <ResearcherView />;
}

function ResearcherView() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [issues, setIssues] = useState<{
    rejected: { sessionId: string; reason: string }[];
    collisions: { participantId: string; names: string[]; sessions: string[] }[];
    warnings: string[];
  }>({ rejected: [], collisions: [], warnings: [] });
  const [tab, setTab] = useState<Tab>("overview");
  const [visible, setVisible] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<StudyUser | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState<string | null>(null);
  const [revoking, setRevoking] = useState("");
  const [deviceNote, setDeviceNote] = useState<string | null>(null);
  // The study passphrase the iPads encrypted their handover files with. Held in
  // memory for the length of a sitting at the laptop, never written down here.
  const [passphrase, setPassphrase] = useState("");

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration;
    setBusy(true);
    const sessions = await storedSessions();
    // Corrections are applied here, at derivation, so a repaired code joins a
    // participant's waves without anything being rewritten (D-37).
    const built = await buildDatasetWithStore(sessions, STUDY, await aliases(), await assignments());
    // Asking the release store can take seconds (up to its timeout when
    // offline), so reloads now overlap: the page-load build can still be
    // waiting when a pull or an import starts another. Only the newest may set
    // what is shown — an older one finishing late would put back a dataset
    // missing the sittings just added. The newest also clears `busy`.
    if (generation !== reloadGeneration) return;
    setDataset(built.dataset);
    // Names go to their own table, never into the dataset the rest of this
    // app reads. They are needed to repair a code and to link a UPN, and the
    // Linkage tab is the only place they surface.
    await storeIdentity(built.identity);
    setIssues({ rejected: built.rejected, collisions: built.collisions, warnings: built.warnings });
    setBusy(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => watchUser(setUser), []);

  const pull = useCallback(async () => {
    setPulling(true);
    setPullNote(null);
    try {
      const { sessions, quarantined, unreadable } = await pullSittings();
      const merged = await mergeFromStudy(sessions, "study");
      const parts = [
        `${plural(merged.added, "sitting")} new`,
        `${merged.superseded} superseded by a longer copy`,
        `${merged.unchanged} already current`,
      ];
      if (quarantined > 0) parts.push(`${plural(quarantined, "sitting")} held for review and left out`);
      if (unreadable.length > 0) parts.push(`could not reassemble ${unreadable.join(", ")} — look at these`);
      setPullNote(parts.join(" · "));
      await reload();
    } catch (error) {
      setPullNote(
        error instanceof Error
          ? `Could not read the study: ${error.message}`
          : "Could not read the study.",
      );
    } finally {
      setPulling(false);
    }
  }, [reload]);

  const table = useMemo(() => (dataset ? wideTable(dataset) : null), [dataset]);
  const summary = useMemo(() => (dataset ? summarise(dataset) : null), [dataset]);

  useEffect(() => {
    if (!table) return;
    // Wait for there to be data before choosing columns. An empty dataset has
    // no variables, so picking defaults from it would leave the table showing
    // nine columns for ever after the first import.
    if (table.rows.length === 0) {
      if (visible !== null) setVisible(null);
      return;
    }
    if (visible === null) setVisible(defaultColumns(table));
  }, [table, visible]);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const next: ImportReport[] = [];
    for (const file of Array.from(files)) {
      next.push(await importExportFile(file.name, await file.text(), passphrase));
    }
    setReports((r) => [...next, ...r].slice(0, 8));
    await reload();
  };

  const loadDemo = async () => {
    if (!latestRelease) return;
    setBusy(true);
    const sessions = buildDemoSessions({ manifest: latestRelease.manifest, participants: 24 });
    const added = await addSessions(sessions, "demonstration data");
    setReports((r) => [{ file: "demonstration data", added, duplicates: sessions.length - added, errors: [] }, ...r]);
    await reload();
  };

  const downloadBids = () => {
    if (!dataset || !latestRelease) return;
    const files = buildBidsExport(dataset, {
      manifest: latestRelease.manifest,
      datasetName: `MySelf ${STUDY}`,
    });
    const blob = new Blob([buildZip(files) as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `myself_${STUDY.toLowerCase()}_bids_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>
            MySelf <span className="dim">researcher view</span>
          </h1>
          <p className="note">
            {STUDY} · {plural(dataset?.sessions.length ?? 0, "sitting")} ·{" "}
            {plural(dataset?.participants.length ?? 0, "participant")}
            {latestRelease ? ` · release ${latestRelease.version}` : ""} · build {__BUILD_STAMP__}
          </p>
        </div>
        <nav className="tabs">
          {(["overview", "table", "linkage", "mystory", "data"] as Tab[]).map((t) => (
            <button key={t} type="button" className={tab === t ? "tab on" : "tab"} onClick={() => setTab(t)}>
              {t === "overview"
                ? "Overview"
                : t === "table"
                  ? "Table"
                  : t === "linkage"
                    ? "Linkage"
                    : t === "mystory"
                      ? "MyStory"
                      : "Data in and out"}
            </button>
          ))}
          <a
            className="tab"
            href="#/surveys"
            style={{ display: "inline-flex", alignItems: "center", textDecoration: "none", color: "var(--accent)" }}
          >
            Survey Studio&nbsp;<span aria-hidden="true">→</span>
          </a>
        </nav>
      </header>

      {busy && <div className="working">Working…</div>}

      {issues.rejected.length > 0 && (
        <div className="alert">
          <strong>{issues.rejected.length} sitting{issues.rejected.length === 1 ? "" : "s"} held back.</strong> These
          could not be linked to a participant, so they are stored but not counted. Guessing the link would join one
          child&apos;s answers to another&apos;s.
          <ul>
            {issues.rejected.slice(0, 5).map((r) => (
              <li key={r.sessionId}>
                {r.sessionId}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.collisions.length > 0 && (
        <div className="alert">
          <strong>
            {issues.collisions.length} code{issues.collisions.length === 1 ? " is" : "s are"} being shared by more
            than one person — almost certainly twins.
          </strong>{" "}
          Up to survey version 7.3.0 the secret code is built from the mother&apos;s initials, a house digit, a
          birth month and postcode letters, and siblings born on the same day share every one of them. (From 8.0.0
          the ID comes from name and date of birth, so twins no longer share one.) Until this is resolved, their answers
          are counted as one person and <strong>any analysis of this dataset is wrong</strong>.
          <ul>
            {issues.collisions.map((c) => (
              <li key={c.participantId}>
                <strong>{c.participantId}</strong> — {c.names.join(" and ")} ({c.sessions.length} sittings).{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    void (async () => {
                      // Give every sitting after the first its own code, so
                      // each twin becomes a participant in their own right.
                      // Which sitting belongs to which name is then checked on
                      // the Linkage tab, where the names are visible.
                      const [, ...rest] = c.sessions;
                      let suffix = 2;
                      for (const sessionId of rest) {
                        await assignSession(
                          sessionId,
                          `${c.participantId}-${suffix}`,
                          `twin split: ${c.names.join(" / ")} share the code ${c.participantId}`,
                        );
                        suffix += 1;
                      }
                      await reload();
                      setTab("linkage");
                    })();
                  }}
                >
                  Separate them
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.warnings.length > 0 && (
        <details className="alert quiet">
          <summary>{issues.warnings.length} note{issues.warnings.length === 1 ? "" : "s"} from the last load</summary>
          <ul>
            {issues.warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {dataset && dataset.sessions.length === 0 && (
        <section className="empty">
          <h2>Nothing here yet</h2>
          <p>
            Import a device export (the JSON file written from the handover panel on an iPad), or load a set of
            made-up sittings to see what this view does.
          </p>
          <div className="empty-actions">
            <button type="button" className="primary" onClick={() => setTab("data")}>
              Import device export
            </button>
            <button type="button" className="secondary" onClick={() => void loadDemo()}>
              Load demonstration data
            </button>
          </div>
        </section>
      )}

      {tab === "overview" && summary && dataset && table && dataset.sessions.length > 0 && (
        <Summary summary={summary} rows={table.rows} />
      )}

      {tab === "table" && table && visible && dataset && dataset.sessions.length > 0 && (
        <DataTable
          table={table}
          visible={visible}
          onVisibleChange={setVisible}
          onSelectParticipant={setSelected}
        />
      )}

      {tab === "linkage" && <Linkage onCorrectionsChanged={() => void reload()} />}

      {tab === "mystory" && <Protocols />}

      {tab === "data" && (
        <section className="panel data-panel">
          <h2>Bring sittings in</h2>

          {studyAvailable && (
            <div className="panel study-pull">
              <h3>From the study</h3>
              {!user && (
                <>
                  <p className="note">
                    Sign in to read the sittings the iPads have uploaded. Your account needs a role on this study — an
                    owner grants one — and signing in on its own is not enough to see anything.
                  </p>
                  <button type="button" className="secondary" onClick={() => void signIn()}>
                    Sign in
                  </button>
                </>
              )}
              {user && !user.role && (
                <p className="note warn">
                  Signed in as {user.email}, but this account has no role on the study, so it cannot read any sittings.
                  An owner grants one before this will work.
                </p>
              )}
              {user?.role && (
                <>
                  <p className="note">
                    Signed in as {user.email} ({user.role}). Pulling is safe to repeat: a sitting already here is left
                    alone unless the study holds a longer copy of it, which happens whenever a device uploaded one
                    while it was still being answered.
                  </p>
                  <div className="handover-actions">
                    <button type="button" className="secondary" disabled={pulling} onClick={() => void pull()}>
                      {pulling ? "Reading the study…" : "Pull sittings from the study"}
                    </button>
                    <button type="button" className="secondary" onClick={() => void signOutOfStudy()}>
                      Sign out
                    </button>
                  </div>
                </>
              )}
              {pullNote && <p className="note">{pullNote}</p>}
            </div>
          )}

          {/*
            No enrolment panel: a participant opens the URL on any iPad and the
            device signs itself in. Revoking is the control that remains, and it
            matters more for being open — the device id is on every sitting in the
            table, so it can be read off the row.
          */}
          {user?.role === "owner" && (
            <div className="panel study-pull">
              <h3>Stop a device</h3>
              <p className="note">
                For an iPad filing something it should not — a stray device, an obvious test run from outside the room.
                Copy its device id from the table and paste it here. It cannot post again, and nothing it already filed
                is removed.
              </p>
              <label className="field">
                <span className="field-label">Device id</span>
                <input
                  className="search wide"
                  value={revoking}
                  placeholder="the deviceId shown against its sittings"
                  onChange={(e) => setRevoking(e.target.value)}
                />
              </label>
              <div className="handover-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={revoking.trim().length === 0}
                  onClick={() => {
                    const id = revoking.trim();
                    setDeviceNote(null);
                    void revokeDevice(id)
                      .then(() => {
                        setRevoking("");
                        setDeviceNote(`${id} can post nothing further.`);
                      })
                      .catch((error: unknown) =>
                        setDeviceNote(error instanceof Error ? error.message : "Could not revoke that device."),
                      );
                  }}
                >
                  Revoke this device
                </button>
              </div>
              {deviceNote && <p className="note">{deviceNote}</p>}
            </div>
          )}

          <h3>From a file</h3>
          <p className="note">
            A device with no usable network hands over as a file instead. Importing the same file twice adds nothing —
            sittings are matched on their identifier — so it is safe to re-import when you are not sure, and a sitting
            that arrives by both roads is one sitting.
          </p>
          <label className="field">
            <span className="field-label">Study passphrase, to open encrypted handover files</span>
            <input
              className="text-input"
              type="password"
              value={passphrase}
              autoComplete="off"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <input
            id="import-file"
            type="file"
            accept="application/json,.json"
            multiple
            className="file"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <label className="secondary file-button" htmlFor="import-file">
            Choose files…
          </label>
          <div
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFiles(e.dataTransfer.files);
            }}
          >
            Drop export files here
          </div>

          {reports.length > 0 && (
            <ul className="reports">
              {reports.map((r, i) => (
                <li key={i}>
                  <strong>{r.file}</strong>: {r.added} added, {r.duplicates} already here
                  {r.errors.length > 0 && <span className="warn"> · {r.errors.join("; ")}</span>}
                </li>
              ))}
            </ul>
          )}

          <h2>Take the dataset out</h2>
          <p className="note">
            The BIDS folder is the archival copy: one file per instrument, a data dictionary beside each, and the
            release hash recorded in the dataset description so the answers stay interpretable. The CSV is whatever
            the table is showing at the time.
          </p>
          <div className="empty-actions">
            <button type="button" className="primary" disabled={!dataset || dataset.sessions.length === 0} onClick={downloadBids}>
              Download BIDS folder (.zip)
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!dataset || dataset.sessions.length === 0}
              onClick={() => {
                if (!dataset) return;
                downloadCsv(
                  JSON.stringify(dataset, null, 2),
                  `myself_${STUDY.toLowerCase()}_dataset.json`,
                );
              }}
            >
              Download raw dataset (JSON)
            </button>
          </div>

          <h2>Demonstration data</h2>
          <p className="note">
            Made-up sittings, for showing the view to somebody. Every one is filed under a site beginning
            &ldquo;DEMO&rdquo;, so it is obvious in the table and can be filtered out — but clear it before the
            first real fieldwork rather than relying on that.
          </p>
          <div className="empty-actions">
            <button type="button" className="secondary" onClick={() => void loadDemo()}>
              Load demonstration data
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!confirm("Delete every sitting stored in this browser? Exports already downloaded are unaffected.")) return;
                void (async () => {
                  await clearAll();
                  setReports([]);
                  await reload();
                })();
              }}
            >
              Clear everything in this browser
            </button>
          </div>
        </section>
      )}

      {selected && table && dataset && (
        <ParticipantPanel participantId={selected} table={table} data={dataset} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
