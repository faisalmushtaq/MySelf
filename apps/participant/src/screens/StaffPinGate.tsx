import { useState } from "react";

/**
 * The staff PIN, in front of the handover panel (lib/pin.ts).
 *
 * `set` the first time the panel is opened on this iPad: staff choose a PIN of
 * four to eight digits and type it twice. `enter` every time after. Where the
 * panel would be, below the build line, and as plain as the panel is.
 */
export interface StaffPinGateProps {
  mode: "set" | "enter";
  /** What the last try found, or why the PIN cannot be tried just now. */
  note: string | null;
  busy: boolean;
  onSet: (pin: string, again: string) => void;
  onEnter: (pin: string) => void;
}

export function StaffPinGate({ mode, note, busy, onSet, onEnter }: StaffPinGateProps) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const digits = (text: string) => text.replace(/[^0-9]/g, "").slice(0, 8);
  const submit = () => {
    if (busy) return;
    if (mode === "set") onSet(pin, again);
    else onEnter(pin);
    setPin("");
    setAgain("");
  };
  const ready = mode === "set" ? pin.length >= 4 && again.length >= 4 : pin.length >= 4;

  return (
    <form
      className="staff-pin"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2>{mode === "set" ? "Set a staff PIN for this iPad" : "Staff PIN"}</h2>
      {mode === "set" && (
        <p className="hint">
          Choose 4 to 8 digits. The handover panel will ask for it from now on. It is kept only on this iPad; if it is
          forgotten, the only reset is clearing this site&apos;s data, which also deletes every sitting not yet uploaded.
        </p>
      )}
      <label className="field">
        <span className="field-label">{mode === "set" ? "New PIN" : "PIN"}</span>
        <input
          className="text-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          disabled={busy}
          onChange={(event) => setPin(digits(event.target.value))}
        />
      </label>
      {mode === "set" && (
        <label className="field">
          <span className="field-label">The same PIN again</span>
          <input
            className="text-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={again}
            disabled={busy}
            onChange={(event) => setAgain(digits(event.target.value))}
          />
        </label>
      )}
      <div className="handover-actions">
        <button type="submit" className="secondary" disabled={!ready || busy}>
          {mode === "set" ? "Set PIN and open" : "Open"}
        </button>
      </div>
      {note && (
        <p className="hint warn" role="alert">
          {note}
        </p>
      )}
    </form>
  );
}
