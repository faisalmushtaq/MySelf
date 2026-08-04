import { useEffect, useState } from "react";
import {
  accessLog,
  corrections,
  identifierFile,
  lookupByCode,
  recordCorrection,
  searchPeople,
  setUpn,
  withdrawCorrection,
  type AccessRecord,
  type CodeCorrection,
  type PersonRecord,
} from "../lib/db.js";

/**
 * Linkage — the only screen in this tool that shows a name.
 *
 * It exists for two jobs that genuinely need one: repairing a code somebody
 * mistyped, so their waves join up, and recording the UPN a school provides.
 * Everything else in the researcher view works on codes and never sees this
 * data.
 *
 * Because it can name a child, using it is made deliberate rather than
 * convenient: a reason has to be typed before anything is shown, and the
 * reason is stored with the lookup. That does not stop anybody — it means
 * there is an account of what was looked at and why, which is the achievable
 * goal and the one an ethics committee will ask about.
 */

export function Linkage({ onCorrectionsChanged }: { onCorrectionsChanged: () => void }) {
  const [why, setWhy] = useState("");
  const [code, setCode] = useState("");
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [upn, setUpnValue] = useState("");
  const [found, setFound] = useState<PersonRecord | null>(null);
  const [hits, setHits] = useState<PersonRecord[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [live, setLive] = useState<CodeCorrection[]>([]);
  const [log, setLog] = useState<AccessRecord[]>([]);
  const [showLog, setShowLog] = useState(false);

  const refresh = () => {
    void corrections().then(setLive);
    void accessLog().then(setLog);
  };
  useEffect(refresh, []);

  const ready = why.trim().length >= 12;

  return (
    <section className="panel linkage">
      <h2>Linkage</h2>
      <p className="note">
        The only place this tool shows a name. Use it to repair a code somebody gave wrongly, or to record the UPN
        a school has provided. Every lookup is recorded below with the reason you give — including the ones that
        find nothing.
      </p>

      <label className="field">
        <span className="field-label">Why are you looking this up?</span>
        <input
          className="search wide"
          value={why}
          placeholder="e.g. wave 2 code does not match wave 1 for this pupil"
          onChange={(e) => setWhy(e.target.value)}
        />
        {!ready && why.length > 0 && <span className="note">A few more words — this is stored against the lookup.</span>}
      </label>

      <div className="linkage-grid">
        <div>
          <h3>Find a person from a code</h3>
          <div className="row">
            <input
              className="search"
              value={code}
              placeholder="JA101CD"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button
              type="button"
              className="secondary"
              disabled={!ready || code.trim() === ""}
              onClick={() => {
                void (async () => {
                  const person = await lookupByCode(code.trim(), why.trim());
                  setFound(person ?? null);
                  setNote(person ? null : "No record for that code.");
                  refresh();
                })();
              }}
            >
              Look up
            </button>
          </div>
          {found && (
            <div className="person">
              <strong>
                {found.givenName} {found.familyName}
              </strong>
              <div className="note">
                born {found.dateOfBirth ?? "—"} · code {found.participantCode} · UPN {found.upn ?? "not linked"}
              </div>
              <div className="row">
                <input
                  className="search"
                  value={upn}
                  placeholder="UPN from the school"
                  onChange={(e) => setUpnValue(e.target.value)}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={!ready || upn.trim() === ""}
                  onClick={() => {
                    void (async () => {
                      const result = await setUpn(found.participantCode, upn.trim(), "school register", why.trim());
                      setNote(result.ok ? "UPN linked." : (result.conflict ?? "Could not link that UPN."));
                      if (result.ok) setFound((await lookupByCode(found.participantCode, why.trim())) ?? null);
                      refresh();
                    })();
                  }}
                >
                  Link UPN
                </button>
              </div>
            </div>
          )}
        </div>

        <div>
          <h3>Find the codes a person has used</h3>
          <p className="note">
            This searches what was typed at every wave, not just what is on file — which is how a mistyped code
            turns up.
          </p>
          <div className="row">
            <input className="search" value={givenName} placeholder="First name" onChange={(e) => setGivenName(e.target.value)} />
            <input className="search" value={familyName} placeholder="Last name" onChange={(e) => setFamilyName(e.target.value)} />
            <button
              type="button"
              className="secondary"
              disabled={!ready || (givenName.trim() === "" && familyName.trim() === "")}
              onClick={() => {
                void (async () => {
                  setHits(await searchPeople({ givenName: givenName.trim(), familyName: familyName.trim() }, why.trim()));
                  refresh();
                })();
              }}
            >
              Search
            </button>
          </div>
          {hits && hits.length === 0 && <p className="note">Nobody matches that name.</p>}
          {hits && hits.length > 1 && (
            <p className="note warn">
              {hits.length} codes match this name. If they are the same person, correct one to the other below —
              their waves will join up the next time the data is derived.
            </p>
          )}
          {hits && hits.length > 0 && (
            <table className="mini">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>On file as</th>
                  <th className="n">Sittings</th>
                  <th>Correct to</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((hit) => (
                  <tr key={hit.participantCode}>
                    <td>{hit.participantCode}</td>
                    <td>
                      {hit.givenName} {hit.familyName}
                    </td>
                    <td className="n">{hit.claims.length}</td>
                    <td>
                      <select
                        className="search"
                        defaultValue=""
                        onChange={(e) => {
                          const target = e.target.value;
                          if (!target) return;
                          void (async () => {
                            const result = await recordCorrection(
                              hit.participantCode,
                              target,
                              `${why.trim()} (same name on file: ${hit.givenName} ${hit.familyName})`,
                            );
                            setNote(result.ok ? "Correction recorded — rebuilding the dataset." : (result.error ?? ""));
                            refresh();
                            if (result.ok) onCorrectionsChanged();
                          })();
                        }}
                      >
                        <option value="">—</option>
                        {hits
                          .filter((other) => other.participantCode !== hit.participantCode)
                          .map((other) => (
                            <option key={other.participantCode} value={other.participantCode}>
                              {other.participantCode}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {note && <p className="note warn">{note}</p>}

      <h3>Take the identifiers out</h3>
      <p className="note">
        Participant code beside the identifiers, and nothing else — no answers. Join it to the phenotype tables on{" "}
        <code>participant_id</code>, or send it to a linkage service. It is deliberately a separate file: one
        carrying both identifiers and answers is the thing this platform is arranged not to produce by accident.
      </p>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={!ready}
          onClick={() => {
            void (async () => {
              const csv = await identifierFile(why.trim());
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `myself_identifiers_${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 30_000);
              setNote("Identifier file downloaded — it contains names. Put it straight into approved storage.");
              refresh();
            })();
          }}
        >
          Download identifier file (CSV)
        </button>
      </div>

      <h3>Corrections in force</h3>
      <p className="note">
        A correction is applied when the dataset is derived. It never edits the event log — what the participant
        actually typed stays on the record — so withdrawing one puts everything back exactly as it was.
      </p>
      {live.filter((c) => c.withdrawnAt === null).length === 0 ? (
        <p className="note">None.</p>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Filed under</th>
              <th>Belongs to</th>
              <th>Reason</th>
              <th>Made</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live
              .filter((c) => c.withdrawnAt === null)
              .map((c) => (
                <tr key={c.id}>
                  <td>{c.wrongCode}</td>
                  <td>{c.rightCode}</td>
                  <td>{c.reason}</td>
                  <td>{c.madeAt.slice(0, 10)}</td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        void (async () => {
                          await withdrawCorrection(c.id);
                          refresh();
                          onCorrectionsChanged();
                        })();
                      }}
                    >
                      Withdraw
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <h3>
        Who looked at what{" "}
        <button type="button" className="link" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "hide" : `show ${log.length}`}
        </button>
      </h3>
      {showLog && (
        <table className="mini">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Looked for</th>
              <th>Reason given</th>
            </tr>
          </thead>
          <tbody>
            {log.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.at.slice(0, 16).replace("T", " ")}</td>
                <td>{entry.action}</td>
                <td>{entry.participant}</td>
                <td>{entry.justification}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
