import { useState, type ReactNode } from "react";
import { PROVENANCE_KIND_LABELS, PROVENANCE_KINDS, type ProvenanceInput, type ProvenanceKind } from "@myself/schema";
import { setProvenance, type InstrumentOrModule } from "@myself/studio";
import { Dialog } from "../../ui/dialog.js";
import { Button, Field, IconButton, Notice } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts, Panel } from "./controls.js";

/**
 * "How it was made" (D-68): whether a questionnaire is validated and used as
 * published, adapted, taken from another study, written by the team or
 * co-produced — and who else had a hand in it. A record about the block, never
 * part of what participants see, so it can be edited on a locked questionnaire
 * or a protected module without unlocking either.
 */

type Involvement = NonNullable<ProvenanceInput["involvement"]>[number];

const KIND_HINTS: Record<ProvenanceKind, string> = {
  validated: "A published, validated questionnaire, asked exactly as published.",
  validated_adapted: "A validated questionnaire with wording, questions or format changed. Say what changed.",
  existing_items: "Questions taken from another study's survey or a standard source (a census, a cohort study), not a validated scale.",
  researcher_developed: "Written by the research team.",
  co_produced: "Developed together with young people or members of the public, such as a Youth Advisory Group.",
  unknown: "Not known yet. Say so rather than guess.",
};

export function provenanceOfDef(def: InstrumentOrModule | null | undefined): ProvenanceInput | null {
  const p = (def as { provenance?: ProvenanceInput } | null | undefined)?.provenance;
  return p ?? null;
}

export function HowMadePanel({ instrument, def }: { instrument: string; def: InstrumentOrModule | null | undefined }) {
  const ctx = useEditor();
  const [editing, setEditing] = useState(false);
  const p = provenanceOfDef(def);
  const rows: { label: string; value: ReactNode }[] = p
    ? [
        { label: "Kind", value: PROVENANCE_KIND_LABELS[p.kind] },
        ...(p.basedOn ? [{ label: "Based on", value: p.basedOn }] : []),
        ...(p.adaptations ? [{ label: "What was changed", value: p.adaptations }] : []),
        ...(p.developedBy ? [{ label: "Developed by", value: p.developedBy }] : []),
        ...(p.involvement && p.involvement.length > 0
          ? [
              {
                label: "Involvement",
                value: (
                  <ul className="stl-bullets">
                    {p.involvement.map((i, n) => (
                      <li key={n}>
                        {i.group}: {i.role}
                        {i.when ? ` (${i.when})` : ""}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]
          : []),
        ...(p.evidence ? [{ label: "Evidence of validity", value: p.evidence }] : []),
        ...(p.decisions && p.decisions.length > 0 ? [{ label: "Decisions", value: p.decisions.join(", ") }] : []),
        ...(p.notes ? [{ label: "Notes", value: p.notes }] : []),
        {
          label: "Checked",
          value: p.confirmed ? `Yes${p.confirmedBy ? `, by ${p.confirmedBy}` : ""}${p.confirmedAt ? ` on ${p.confirmedAt}` : ""}` : "Not yet checked by the team",
        },
      ]
    : [];
  return (
    <Panel
      title="How it was made"
      info="Where these questions came from: a validated instrument, an adaptation, another study, the research team, or co-produced (for example with a Youth Advisory Group). Participants never see it, and editing it needs no unlock."
      actions={
        <Button size="sm" variant="secondary" icon="history" onClick={() => setEditing(true)} disabled={!ctx.canEdit}>
          {p ? "Edit…" : "Record…"}
        </Button>
      }
    >
      {p ? <Facts rows={rows} /> : <p className="stn-flush stn-muted">Not recorded. Say how these questions were made, so it can always be referred back to.</p>}
      {editing ? <ProvenanceDialog instrument={instrument} name={def?.name ?? instrument} initial={p} onClose={() => setEditing(false)} /> : null}
    </Panel>
  );
}

const DECISION = /^D-\d+$/;
const WHEN = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function ProvenanceDialog({
  instrument,
  name,
  initial,
  onClose,
}: {
  instrument: string;
  name: string;
  initial: ProvenanceInput | null;
  onClose: () => void;
}) {
  const ctx = useEditor();
  const [kind, setKind] = useState<ProvenanceKind>(initial?.kind ?? "unknown");
  const [basedOn, setBasedOn] = useState(initial?.basedOn ?? "");
  const [adaptations, setAdaptations] = useState(initial?.adaptations ?? "");
  const [developedBy, setDevelopedBy] = useState(initial?.developedBy ?? "");
  const [involvement, setInvolvement] = useState<Involvement[]>(initial?.involvement ?? []);
  const [evidence, setEvidence] = useState(initial?.evidence ?? "");
  const [decisions, setDecisions] = useState((initial?.decisions ?? []).join(", "));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [confirmed, setConfirmed] = useState(initial?.confirmed ?? false);
  const [confirmedBy, setConfirmedBy] = useState(initial?.confirmedBy ?? "");
  const [submitted, setSubmitted] = useState(false);

  const decisionList = decisions
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const problems = {
    adaptations: kind === "validated_adapted" && !adaptations.trim() ? "Say what was changed from the published version." : null,
    basedOn: (kind === "validated" || kind === "validated_adapted" || kind === "existing_items") && !basedOn.trim() ? "Say what it was taken from." : null,
    involvement:
      kind === "co_produced" && involvement.filter((i) => i.group.trim() && i.role.trim()).length === 0
        ? "Say who it was co-produced with, and what they did."
        : involvement.some((i) => (i.group.trim() === "") !== (i.role.trim() === "") || (i.when && !WHEN.test(i.when)))
          ? "Each line needs who and what they did; a date is a year, year-month or full date (2026-09)."
          : null,
    decisions: decisionList.some((d) => !DECISION.test(d)) ? "Decisions are written like D-67, separated by commas." : null,
    confirmedBy: confirmed && !confirmedBy.trim() ? "Say who checked it (a name or role, not an email)." : null,
    email: [developedBy, confirmedBy, ...involvement.map((i) => i.group)].some((t) => /\S+@\S+/.test(t)) ? "Use names or roles, not email addresses: this record is published with the survey." : null,
  };
  const valid = Object.values(problems).every((p) => !p);

  const save = () => {
    setSubmitted(true);
    if (!valid) return;
    const text = (s: string) => (s.trim() ? s.trim() : undefined);
    const lines = involvement
      .filter((i) => i.group.trim() && i.role.trim())
      .map((i) => ({ group: i.group.trim(), role: i.role.trim(), ...(i.when?.trim() ? { when: i.when.trim() } : {}) }));
    const record: ProvenanceInput = Object.fromEntries(
      Object.entries({
        kind,
        basedOn: text(basedOn),
        adaptations: text(adaptations),
        developedBy: text(developedBy),
        involvement: lines.length > 0 ? lines : undefined,
        evidence: text(evidence),
        decisions: decisionList.length > 0 ? decisionList : undefined,
        notes: text(notes),
        confirmed,
        confirmedBy: confirmed ? text(confirmedBy) : undefined,
        confirmedAt: confirmed ? (initial?.confirmed && initial.confirmedAt ? initial.confirmedAt : new Date().toISOString().slice(0, 10)) : undefined,
      }).filter(([, v]) => v !== undefined),
    ) as ProvenanceInput;
    if (ctx.run(`Record how “${name}” was made`, (d) => setProvenance(d, instrument, record).draft)) {
      ctx.announce(`Recorded how ${name} was made.`);
      onClose();
    }
  };

  const setLine = (n: number, patch: Partial<Involvement>) => setInvolvement((prev) => prev.map((x, i) => (i === n ? { ...x, ...patch } : x)));

  return (
    <Dialog
      title={`How “${name}” was made`}
      onClose={onClose}
      width={620}
      description={
        <p className="stn-flush">
          A record kept with the questionnaire, so anyone can later tell how it was created. Participants never see it, and it changes nothing about how answers are
          stored or scored.
        </p>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!ctx.canEdit}>
            Save record
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Kind" hint={KIND_HINTS[kind]}>
          {(p) => (
            <select {...p} className="st-select" value={kind} onChange={(e) => setKind(e.target.value as ProvenanceKind)}>
              {PROVENANCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROVENANCE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Based on" optional={!problems.basedOn} hint="The instrument, study or source, with a citation if there is one." error={submitted ? problems.basedOn : null}>
          {(p) => <textarea {...p} className="st-input" rows={2} value={basedOn} onChange={(e) => setBasedOn(e.target.value)} />}
        </Field>
        <Field label="What was changed, and why" optional={kind !== "validated_adapted"} error={submitted ? problems.adaptations : null}>
          {(p) => <textarea {...p} className="st-input" rows={2} value={adaptations} onChange={(e) => setAdaptations(e.target.value)} />}
        </Field>
        <Field label="Developed by" optional hint="A team or role, for example: YBM research team.">
          {(p) => <input {...p} className="st-input" value={developedBy} onChange={(e) => setDevelopedBy(e.target.value)} autoComplete="off" />}
        </Field>

        <fieldset className="stp-fieldset">
          <legend className="st-field-label">Who else was involved{kind === "co_produced" ? "" : " (optional)"}</legend>
          {involvement.map((line, n) => (
            <div key={n} className="stn-provenance-line">
              <input
                className="st-input"
                aria-label={`Who (line ${n + 1})`}
                placeholder="Youth Advisory Group"
                value={line.group}
                onChange={(e) => setLine(n, { group: e.target.value })}
              />
              <input
                className="st-input"
                aria-label={`What they did (line ${n + 1})`}
                placeholder="co-wrote the questions"
                value={line.role}
                onChange={(e) => setLine(n, { role: e.target.value })}
              />
              <input
                className="st-input stn-provenance-when"
                aria-label={`When (line ${n + 1})`}
                placeholder="2026-09"
                value={line.when ?? ""}
                onChange={(e) => setLine(n, { when: e.target.value })}
              />
              <IconButton size="sm" icon="close" label={`Remove line ${n + 1}`} onClick={() => setInvolvement((prev) => prev.filter((_, i) => i !== n))} />
            </div>
          ))}
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setInvolvement((prev) => [...prev, { group: "", role: "" }])}>
            Add who was involved
          </Button>
          {submitted && problems.involvement ? <p className="st-field-msg st-field-msg-error">{problems.involvement}</p> : null}
        </fieldset>

        <Field label="Evidence of validity" optional hint="A validation study, or “none yet”.">
          {(p) => <input {...p} className="st-input" value={evidence} onChange={(e) => setEvidence(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Decisions" optional hint="From the decision log, for example: D-59, D-67." error={submitted ? problems.decisions : null}>
          {(p) => <input {...p} className="st-input" value={decisions} onChange={(e) => setDecisions(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Notes" optional>
          {(p) => <textarea {...p} className="st-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>

        <label className="stp-radio">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            <strong>Checked by the team</strong>
            <small>Tick once someone who knows has checked this record is right.</small>
          </span>
        </label>
        {confirmed ? (
          <Field label="Checked by" hint="A name or role." error={submitted ? problems.confirmedBy : null}>
            {(p) => <input {...p} className="st-input" value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} autoComplete="off" />}
          </Field>
        ) : null}
        {submitted && problems.email ? <Notice tone="error">{problems.email}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
