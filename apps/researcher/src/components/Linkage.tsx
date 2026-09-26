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
  createIdentityVault,
  identityIsUnlocked,
  identityVaultExists,
  lockIdentity,
  unlockIdentity,
  type AccessRecord,
  type CodeCorrection,
  type PersonRecord,
} from "../lib/db.js";
import { passphraseComplaint } from "../lib/vault.js";

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
 *
 * AND IT IS LOCKED. The names, dates of birth, UPNs and NHS numbers behind this
 * screen used to sit in IndexedDB in the clear, in a browser with no sign-in and
 * no lock, on a laptop that goes home in a bag — while the participant app has
 * encrypted its far less sensitive storage since the first version. They are now
 * sealed under a study passphrase that is never written to the machine, so a
 * closed laptop holds names it cannot read.
 *
 * The lock is here rather than over the whole app on purpose: the sittings are
 * keyed by participant code and carry no names, so the overview, the table and
 * the export all work locked. Only this screen needs the passphrase, which means
 * it is typed when somebody actually has linkage work to do rather than every
 * morning as a matter of routine.
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
  const [unlocked, setUnlocked] = useState(identityIsUnlocked());

  const refresh = () => {
    void corrections().then(setLive);
    void accessLog().then(setLog);
  };
  useEffect(refresh, []);

  /**
   * Lock it again when nobody is there.
   *
   * A laptop left open on a staffroom table with the names on screen is the
   * ordinary case, not the paranoid one. Fifteen minutes of the tab being hidden
   * or the window being unfocused is long enough not to interrupt somebody
   * cross-checking a spreadsheet, and short enough to matter over a lunch break.
   */
  useEffect(() => {
    if (!unlocked) return;
    let timer: number | undefined;
    const lock = () => {
      lockIdentity();
      setUnlocked(false);
      setFound(null);
      setHits(null);
    };
    const arm = () => {
      window.clearTimeout(timer);
      if (document.hidden) timer = window.setTimeout(lock, 15 * 60 * 1000);
    };
    document.addEventListener("visibilitychange", arm);
    arm();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [unlocked]);

  const ready = why.trim().length >= 12;

  if (!unlocked) {
    return (
      <VaultGate
        onUnlocked={() => {
          setUnlocked(true);
          refresh();
          // Names are derived from the sittings on every load and skipped while
          // the vault is locked, so unlocking has to ask for that derivation
          // again — otherwise the table is empty until the page is reloaded.
          onCorrectionsChanged();
        }}
      />
    );
  }

  return (
    <section className="panel linkage">
      <h2>Linkage</h2>
      <div className="handover-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            lockIdentity();
            setUnlocked(false);
            setFound(null);
            setHits(null);
          }}
        >
          Lock
        </button>
      </div>
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

/**
 * The passphrase screen.
 *
 * Two states rather than one, because "set a passphrase" and "type the
 * passphrase" are different situations and a single prompt would silently let
 * somebody create a second vault by mistyping the first — which would read as
 * every name in the study having vanished.
 */
function VaultGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [exists, setExists] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void identityVaultExists().then(setExists);
  }, []);

  if (exists === null) return <section className="panel linkage" />;

  const complaint = passphraseComplaint(passphrase);
  const mismatched = !exists && again !== passphrase;

  const submit = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (exists) await unlockIdentity(passphrase);
        else await createIdentityVault(passphrase);
        setPassphrase("");
        setAgain("");
        onUnlocked();
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : "could not unlock");
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section className="panel linkage">
      <h2>{exists ? "Unlock linkage" : "Set the linkage passphrase"}</h2>
      <p className="note">
        {exists
          ? "The names behind this screen are encrypted on this laptop. The passphrase is the study's, shared with whoever does linkage, and is not stored here — so if it is lost the names are rebuilt from the sittings the next time a new one is set."
          : "Choose the study's linkage passphrase. It encrypts every name, date of birth, UPN and NHS number this laptop holds, and it is not stored anywhere on the machine. Keep it where the study keeps its other credentials, not in this browser."}
      </p>
      <label className="field">
        <span className="field-label">Passphrase</span>
        <input
          className="search wide"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !complaint && !mismatched) submit();
          }}
        />
      </label>
      {!exists && (
        <label className="field">
          <span className="field-label">Passphrase again</span>
          <input
            className="search wide"
            type="password"
            value={again}
            autoComplete="off"
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
      )}
      {passphrase.length > 0 && complaint && <p className="note">{complaint}</p>}
      {mismatched && again.length > 0 && <p className="note warn">Those two do not match.</p>}
      {error && <p className="note warn">{error}</p>}
      <button type="button" className="secondary" disabled={busy || complaint !== null || mismatched} onClick={submit}>
        {exists ? "Unlock" : "Set passphrase"}
      </button>
    </section>
  );
}
