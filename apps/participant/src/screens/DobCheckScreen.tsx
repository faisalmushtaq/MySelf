import { useState } from "react";
import type { AnswerValue } from "@myself/engine";
import type { ItemDefinition } from "@myself/schema";
import { DateControl } from "../components/controls/DateControl.js";

/**
 * "To carry on, enter your date of birth" — between a code that matches an
 * unfinished sitting and that sitting (lib/dob.ts says when it is asked).
 *
 * Drawn with the sitting's own date question, through the same control the
 * survey uses, so the picker, its limits and the "that makes you 12" read-back
 * are the ones the child met the first time. Nothing from the sitting is on
 * this screen: not the name, not the date being checked against. A sitting
 * that holds a first name asks for it as well (D-75): twins share a date.
 */
export interface DobCheckScreenProps {
  /** The release's date-of-birth question, for the control. */
  item: ItemDefinition;
  /** Ask for the first name too: the sitting holds one (D-75). */
  askName: boolean;
  /** What the last try found, if it was wrong. */
  note: string | null;
  /** Three wrong dates: no more tries on this iPad until staff allow it. */
  locked: boolean;
  busy: boolean;
  onCheck: (iso: string, firstName: string) => void;
  /** Back to the start screen, carrying on nothing. */
  onCancel: () => void;
}

export function DobCheckScreen({ item, askName, note, locked, busy, onCheck, onCancel }: DobCheckScreenProps) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  const [ok, setOk] = useState(false);
  const [name, setName] = useState("");
  const iso = value?.kind === "date" ? value.iso : "";
  const ready = ok && Boolean(iso) && (!askName || name.trim().length > 0);

  if (locked) {
    return (
      <div className="screen checkin dob-check" role="alert">
        <h1>Let&apos;s get some help</h1>
        <p>This sitting can&apos;t be carried on with on this iPad. Please put your hand up and ask a member of the research team.</p>
        <div className="checkin-actions">
          <button type="button" className="next big" onClick={() => onCancel()}>
            OK
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen checkin dob-check">
      <h1>Welcome back</h1>
      <p>{askName ? "To carry on, enter your first name and your date of birth." : "To carry on, enter your date of birth."}</p>
      {askName && (
        <label className="name-field">
          <span>Your first name</span>
          <input
            type="text"
            className="text-input first-name"
            value={name}
            maxLength={100}
            autoCapitalize="words"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <DateControl
        item={item}
        value={value}
        onAnswer={(answer) => {
          setValue(answer);
          setOk(true);
        }}
        onValidity={(state) => setOk(state.ok && state.complete)}
        onSubmit={() => {
          if (ready && !busy) onCheck(iso, name);
        }}
      />

      {note && (
        <p className="error" role="alert">
          {note}
        </p>
      )}
      <div className="checkin-actions">
        <button type="button" className="next big" disabled={!ready || busy} onClick={() => onCheck(iso, name)}>
          Carry on
        </button>
        <button type="button" className="decline dob-cancel" onClick={() => onCancel()}>
          That&apos;s not me
        </button>
      </div>
    </div>
  );
}
