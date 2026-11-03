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
 * that holds a name asks for its initials as well (D-75): twins share a date.
 */
export interface DobCheckScreenProps {
  /** The release's date-of-birth question, for the control. */
  item: ItemDefinition;
  /** Ask for initials too: the sitting holds a name (D-75). */
  askInitials: boolean;
  /** What the last try found, if it was wrong. */
  note: string | null;
  /** Three wrong dates: no more tries on this iPad until staff allow it. */
  locked: boolean;
  busy: boolean;
  onCheck: (iso: string, initials: string) => void;
  /** Back to the start screen, carrying on nothing. */
  onCancel: () => void;
}

export function DobCheckScreen({ item, askInitials, note, locked, busy, onCheck, onCancel }: DobCheckScreenProps) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  const [ok, setOk] = useState(false);
  const [initials, setInitials] = useState("");
  const iso = value?.kind === "date" ? value.iso : "";
  const ready = ok && Boolean(iso) && (!askInitials || initials.replace(/[^\p{L}]/gu, "").length >= 1);

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
      <p>{askInitials ? "To carry on, enter your date of birth and your initials." : "To carry on, enter your date of birth."}</p>
      <DateControl
        item={item}
        value={value}
        onAnswer={(answer) => {
          setValue(answer);
          setOk(true);
        }}
        onValidity={(state) => setOk(state.ok && state.complete)}
        onSubmit={() => {
          if (ready && !busy) onCheck(iso, initials);
        }}
      />
      {askInitials && (
        <label className="initials-field">
          <span>Your initials (the first letter of your first name and your last name)</span>
          <input
            type="text"
            className="text-input initials"
            value={initials}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="e.g. SK"
            onChange={(e) => setInitials(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready && !busy) onCheck(iso, initials);
            }}
          />
        </label>
      )}
      {note && (
        <p className="error" role="alert">
          {note}
        </p>
      )}
      <div className="checkin-actions">
        <button type="button" className="next big" disabled={!ready || busy} onClick={() => onCheck(iso, initials)}>
          Carry on
        </button>
        <button type="button" className="decline dob-cancel" onClick={() => onCancel()}>
          That&apos;s not me
        </button>
      </div>
    </div>
  );
}
