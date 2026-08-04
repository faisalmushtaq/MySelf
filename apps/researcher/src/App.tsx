import { useCallback, useEffect, useMemo, useState } from "react";
import { buildBidsExport, buildDemoSessions, buildZip, summarise, wideTable, type Dataset } from "@myself/store";
import { DataTable, downloadCsv } from "./components/DataTable.js";
import { Linkage } from "./components/Linkage.js";
import { ParticipantPanel } from "./components/ParticipantPanel.js";
import { Protocols } from "./components/Protocols.js";
import { Summary } from "./components/Summary.js";
import { buildDataset } from "./lib/build.js";
import {
  addSessions,
  aliases,
  assignSession,
  assignments,
  clearAll,
  importExportFile,
  storeIdentity,
  storedSessions,
  type ImportReport,
} from "./lib/db.js";
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

type Tab = "overview" | "table" | "linkage" | "mystory" | "data";

export default function App() {
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

  const reload = useCallback(async () => {
    setBusy(true);
    const sessions = await storedSessions();
    // Corrections are applied here, at derivation, so a repaired code joins a
    // participant's waves without anything being rewritten (D-37).
    const built = buildDataset(sessions, STUDY, await aliases(), await assignments());
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
      next.push(await importExportFile(file.name, await file.text()));
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
          The secret code is built from the mother&apos;s initials, a house digit, a birth month and postcode
          letters, and siblings born on the same day share every one of them. Until this is resolved, their answers
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
          <p className="note">
            Each iPad writes one file from its handover panel. Importing the same file twice adds nothing — sittings
            are matched on their identifier — so it is safe to re-import when you are not sure.
          </p>
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
