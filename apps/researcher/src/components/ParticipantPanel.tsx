import { useState } from "react";
import type { Dataset, WideTable } from "@myself/store";
import { lookupByCode, type PersonRecord } from "../lib/db.js";
import { participantWaves } from "../lib/longitudinal.js";

/**
 * One person, every wave.
 *
 * This is the view that makes a follow-up visit possible: it answers "has this
 * code been here before, and what did they say last time?" without exposing a
 * name — because the platform does not hold the link between the code and the
 * name in the same place as the answers, and this screen is no exception.
 */

/** Columns describing the sitting rather than the answers given in it. */
const SESSION_COLUMNS = [
  "participant_id",
  "session_id",
  "wave",
  "site",
  "started",
  "minutes",
  "answered",
  "skipped",
  "too_fast",
  "complete",
];

export interface ParticipantPanelProps {
  participantId: string;
  table: WideTable;
  data: Dataset;
  onClose: () => void;
}

export function ParticipantPanel({ participantId, table, data, onClose }: ParticipantPanelProps) {
  // Who this code belongs to is available here, because sometimes it has to
  // be — checking a sitting against a register, chasing a follow-up. It is
  // asked for rather than shown, and the asking is recorded, so the screen a
  // researcher has open all day does not have a child's name on it.
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [named, setNamed] = useState<PersonRecord | null>(null);
  const waves = participantWaves(table.rows, participantId);
  const person = data.participants.find((p) => p.participantId === participantId);
  const scoreKeys = [...new Set(data.scores.map((s) => `${s.instrument}_${s.output}`))]
    .filter((key) => waves.some((w) => typeof w[key] === "number"))
    .sort();

  return (
    <aside className="drawer" role="dialog" aria-label={`Participant ${participantId}`}>
      <div className="drawer-head">
        <div>
          <h2>{participantId}</h2>
          {named ? (
            <p className="note revealed">
              <strong>
                {named.givenName} {named.familyName}
              </strong>
              {named.dateOfBirth ? ` · born ${named.dateOfBirth}` : ""}
              {named.upn ? ` · UPN ${named.upn}` : ""}
              {named.nhsNumber ? ` · NHS ${named.nhsNumber}` : ""}
            </p>
          ) : asking ? (
            <div className="row reveal-ask">
              <input
                className="search"
                autoFocus
                value={why}
                placeholder="Why do you need to know who this is?"
                onChange={(e) => setWhy(e.target.value)}
              />
              <button
                type="button"
                className="secondary"
                disabled={why.trim().length < 12}
                onClick={() => {
                  void (async () => {
                    const found = await lookupByCode(participantId, why.trim());
                    setNamed(found ?? null);
                    setAsking(false);
                    if (!found) setWhy("");
                  })();
                }}
              >
                Show
              </button>
            </div>
          ) : (
            <button type="button" className="link" onClick={() => setAsking(true)}>
              Who is this?
            </button>
          )}
          <p className="note">
            {person ? `${person.sessionCount} sitting${person.sessionCount === 1 ? "" : "s"}` : "no sittings"}
            {person && person.sites.length > 0 ? ` · ${person.sites.join(", ")}` : ""}
          </p>
        </div>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      <table className="mini">
        <thead>
          <tr>
            <th className="n">Wave</th>
            <th>Date</th>
            <th>Site</th>
            <th className="n">Minutes</th>
            <th className="n">Answered</th>
            <th className="n">Skipped</th>
            <th>Complete</th>
          </tr>
        </thead>
        <tbody>
          {waves.map((w) => (
            <tr key={String(w["session_id"])}>
              <td className="n">{String(w["wave"])}</td>
              <td>{String(w["started"] ?? "—")}</td>
              <td>{String(w["site"] ?? "—")}</td>
              <td className="n">{String(w["minutes"] ?? "—")}</td>
              <td className="n">{String(w["answered"] ?? "—")}</td>
              <td className="n">{String(w["skipped"] ?? "—")}</td>
              <td>{String(w["complete"] ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {scoreKeys.length > 0 && (
        <>
          <h3>Measures by wave</h3>
          <table className="mini">
            <thead>
              <tr>
                <th>Measure</th>
                {waves.map((w) => (
                  <th key={String(w["session_id"])} className="n">
                    W{String(w["wave"])}
                  </th>
                ))}
                <th className="n">Change</th>
              </tr>
            </thead>
            <tbody>
              {scoreKeys.map((key) => {
                const values = waves.map((w) => (typeof w[key] === "number" ? (w[key] as number) : null));
                const present = values.filter((v): v is number => v !== null);
                const change =
                  present.length > 1 ? present[present.length - 1]! - present[0]! : null;
                return (
                  <tr key={key}>
                    <td>{key}</td>
                    {values.map((v, i) => (
                      <td key={i} className="n">
                        {v === null ? "—" : Number.isInteger(v) ? v : v.toFixed(1)}
                      </td>
                    ))}
                    <td className={`n ${change === null ? "" : change > 0 ? "up" : change < 0 ? "down" : ""}`}>
                      {change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <h3>Answers</h3>
      <div className="answers">
        <table className="mini">
          <thead>
            <tr>
              <th>Variable</th>
              {waves.map((w) => (
                <th key={String(w["session_id"])}>W{String(w["wave"])}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.columns
              // The sitting's own metadata is in the table above; repeating it
              // here just pushes the answers off the screen.
              .filter((c) => !SESSION_COLUMNS.includes(c.key))
              .filter((c) => waves.some((w) => w[c.key] !== undefined && w[c.key] !== null))
              .map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  {waves.map((w) => (
                    <td key={String(w["session_id"])}>
                      {/* Answers are mostly option labels; left-aligned they
                          read as a column of words rather than a ledger. */}
                      {w[c.key] === null || w[c.key] === undefined ? "—" : String(w[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
