import { useEffect, useMemo, useRef, useState } from "react";
import { normalisePostcode, type StreetList, type StreetMatch } from "@myself/engine";
import { postcodeList } from "../../lib/postcodes.js";
import { streetList as loadStreets } from "../../lib/streets.js";
import type { ControlProps } from "./shared.js";

export function FormFieldsControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  if (item.responseType !== "form_fields") return null;
  const current = value?.kind === "fields" ? value.values : {};
  const [values, setValues] = useState<Record<string, string>>(current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, string> | null>(null);

  // A postcode field is checked against the release's list (D-52). One the list
  // does not know is questioned, never refused, in two steps: is it typed
  // correctly, and is the home really outside the area? Only a participant who
  // says yes to both moves on with it, and it is kept as typed. A postcode
  // already saved was confirmed when it was given, so a return visit does not
  // ask again.
  const check = item.postcodeCheck;
  const list = check ? postcodeList(check.asset) : null;
  const saved = check ? normalisePostcode(current[check.field] ?? "") : null;
  /** The postcode the participant said is typed correctly (step one). */
  const [typedRight, setTypedRight] = useState<string | null>(saved);
  /** The postcode the participant said is outside the area (step two). */
  const [confirmed, setConfirmed] = useState<string | null>(saved);
  const postcodeInput = useRef<HTMLInputElement | null>(null);
  const postcodeState = (vals: Record<string, string>, confirmedPostcode: string | null) => {
    if (!check || !list) return { normal: null, area: null, needsConfirm: false };
    const normal = normalisePostcode(vals[check.field] ?? "");
    const area = normal ? list.lookup(normal) : null;
    return { normal, area, needsConfirm: normal !== null && area === null && confirmedPostcode !== normal };
  };

  // Someone who doesn't know their postcode can say so, and find their street
  // in the release's list instead (D-53). The match they choose is recorded
  // beside the fields; a street the list does not know is kept as typed.
  const streets = check ? item.streetCheck : undefined;
  const [noPostcode, setNoPostcode] = useState(
    streets !== undefined && !(current[check!.field] ?? "").trim() && Boolean(current[streets.areaKey] || current[streets.districtKey]),
  );
  const [streetList, setStreetList] = useState<StreetList | null>(null);
  const [streetQuery, setStreetQuery] = useState("");
  const streetInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!noPostcode || !streets) return;
    let live = true;
    void loadStreets(streets.asset).then((l) => live && setStreetList(l));
    return () => {
      live = false;
    };
  }, [noPostcode, streets?.asset]);
  // Searched a beat after typing stops, not on every keystroke.
  useEffect(() => {
    if (!noPostcode || !streets) return;
    const t = setTimeout(() => setStreetQuery(values[streets.field] ?? ""), 250);
    return () => clearTimeout(t);
  }, [noPostcode, streets?.field, values[streets?.field ?? ""]]);
  const chosenStreet = streets && values[streets.areaKey] !== undefined ? values : null;
  const matches = useMemo(
    () => (streetList && noPostcode && !chosenStreet && streetQuery.trim() ? streetList.search(streetQuery, 5) : []),
    [streetList, noPostcode, chosenStreet, streetQuery],
  );

  const report = (next: Record<string, string>, confirmedPostcode: string | null) => {
    if (item.responseType !== "form_fields") return;
    // Validity is judged across the whole form, not just the field just typed
    // in: a single bad entry must block the screen even if the others are fine.
    const anyBad = item.fields.some((f) => {
      const raw = (next[f.key] ?? "").trim();
      return f.pattern !== undefined && raw.length > 0 && !new RegExp(f.pattern).test(raw);
    });
    const allRequiredPresent = item.fields.every((f) => !f.required || (next[f.key] ?? "").trim().length > 0);
    // An emptied form is not an answer: it goes the way of any blank item.
    const anyPresent = Object.values(next).some((x) => x.trim().length > 0);
    const ok = !anyBad && !postcodeState(next, confirmedPostcode).needsConfirm;
    onValidity?.({ ok, complete: ok && allRequiredPresent && anyPresent });
  };
  const postcode = postcodeState(values, confirmed);

  /** Put a new set of values on screen, check it, and autosave it after a pause. */
  const apply = (next: Record<string, string>, nextErrors: Record<string, string>) => {
    setValues(next);
    setErrors(nextErrors);
    report(next, confirmed);
    if (Object.keys(nextErrors).length > 0) {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      if (Object.values(next).some((x) => x.trim().length > 0)) onAnswer({ kind: "fields", values: next }, false);
    }, 400);
  };

  /** The values without a chosen street match: it no longer describes what is typed. */
  const withoutMatch = (vals: Record<string, string>) => {
    if (!streets) return vals;
    const { [streets.areaKey]: _area, [streets.districtKey]: _district, ...rest } = vals;
    return rest;
  };

  const commit = (key: string, raw: string) => {
    if (item.responseType !== "form_fields") return;
    // Truncate here, not only via maxLength: iOS AutoFill/QuickType inserts
    // values programmatically and bypasses the attribute entirely.
    // A numeric field never holds a letter: strip rather than accept-and-scold.
    const field = item.fields.find((f) => f.key === key);
    const cleaned = field?.kind === "numeric" ? raw.replace(/[^0-9]/g, "") : raw;
    const v = field ? cleaned.slice(0, field.maxChars) : cleaned;
    let next = { ...values, [key]: v };
    // Changing the street, or giving a postcode after all, undoes a match.
    if (streets && (key === streets.field || (key === check?.field && v.trim()))) next = withoutMatch(next);
    if (streets && key === check?.field && v.trim() && noPostcode) setNoPostcode(false);
    const bad = field?.pattern && v.trim().length > 0 && !new RegExp(field.pattern).test(v.trim());
    const nextErrors = { ...errors };
    if (bad) nextErrors[key] = field?.patternHint ?? "Please check the format";
    else delete nextErrors[key];
    apply(next, nextErrors);
  };

  const dontKnowPostcode = () => {
    if (!check) return;
    const nextErrors = { ...errors };
    delete nextErrors[check.field];
    setNoPostcode(true);
    setTypedRight(null);
    apply({ ...values, [check.field]: "" }, nextErrors);
    streetInput.current?.focus();
  };

  const chooseStreet = (m: StreetMatch) => {
    if (!streets) return;
    apply({ ...values, [streets.field]: m.street, [streets.areaKey]: m.area, [streets.districtKey]: m.outward }, errors);
  };

  // Flush pending field edits on unmount (see TextControl).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const next = pending.current;
      if (next && Object.values(next).some((x) => x.trim().length > 0)) {
        onAnswer({ kind: "fields", values: next }, false);
      }
    },
    [],
  );

  /** Offered wherever the postcode is empty or unknown to the list, never once it is found. */
  const offerDontKnow =
    streets !== undefined && !noPostcode && (postcode.normal === null ? !(values[check!.field] ?? "").trim() || !!errors[check!.field] : postcode.needsConfirm);

  return (
    <div className="fields">
      {item.fields.map((f) => {
        const isPostcode = check !== undefined && f.key === check.field;
        const isStreet = streets !== undefined && f.key === streets.field;
        const noteId = `${item.key}-${f.key}-note`;
        const note = isPostcode
          ? noPostcode
            ? "That's fine — type your street below and choose it from the list."
            : !errors[f.key] && postcode.normal
              ? postcode.area
                ? `✓ ${postcode.area.ward}, ${postcode.area.district}`
                : postcode.needsConfirm
                  ? typedRight === postcode.normal
                    ? `Is your home outside ${check!.areaName}?`
                    : `We can't find ${postcode.normal} in ${check!.areaName}. Check it's typed correctly.`
                  : `✓ Kept as you gave it — outside ${check!.areaName}`
              : null
          : isStreet && noPostcode
            ? chosenStreet
              ? `✓ ${values[streets!.field]}, ${values[streets!.areaKey]}${values[streets!.districtKey] ? ` (${values[streets!.districtKey]})` : ""}`
              : !(values[f.key] ?? "").trim()
                ? null
                : streetList === null
                  ? "Looking for your street…"
                  : matches.length > 0
                    ? "Is it one of these?"
                    : streetQuery.trim().replace(/[^A-Za-z]/g, "").length >= 3
                      ? `We can't find that street in ${check!.areaName}. Check the spelling — or carry on, and we'll keep it as you typed it.`
                      : null
            : null;
        return (
          <div key={f.key} className="field-group">
            <label className="field">
              <span className="field-label">{f.label}</span>
              <input
                // Always type=text: type=number ignores maxLength and accepts "e",
                // "+" and "-". inputMode drives the on-screen keyboard instead.
                type="text"
                inputMode={f.kind === "numeric" || /^\^\[0-9\]/.test(f.pattern ?? "") ? "numeric" : "text"}
                className="text-input"
                maxLength={f.maxChars}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={values[f.key] ?? ""}
                aria-invalid={errors[f.key] !== undefined}
                aria-describedby={isPostcode || isStreet ? noteId : undefined}
                ref={isPostcode ? postcodeInput : isStreet ? streetInput : undefined}
                onChange={(e) => commit(f.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  // Enter walks down the form, then moves on from the last field.
                  const inputs = Array.from(
                    e.currentTarget.closest(".fields")?.querySelectorAll("input") ?? [],
                  ) as HTMLInputElement[];
                  const at = inputs.indexOf(e.currentTarget);
                  const next = inputs[at + 1];
                  if (next) {
                    next.focus();
                    return;
                  }
                  if (timer.current) clearTimeout(timer.current);
                  const draft = pending.current;
                  pending.current = null;
                  if (draft && Object.values(draft).some((x) => x.trim().length > 0)) {
                    onAnswer({ kind: "fields", values: draft }, false);
                  }
                  onSubmit?.();
                }}
              />
              {errors[f.key] && (
                <span className="error" role="alert">
                  {errors[f.key]}
                </span>
              )}
            </label>
            {(isPostcode || (isStreet && noPostcode)) && (
              // Said back, not shouted: the area a postcode lies in, or a request to
              // check one the list does not know (D-52); the street found (D-53).
              <p id={noteId} className="field-note" aria-live="polite">
                {note}
              </p>
            )}
            {isPostcode && !noPostcode && !errors[f.key] && postcode.needsConfirm && typedRight !== postcode.normal && (
              <div className="confirm-row">
                <button type="button" className="confirm-postcode" onClick={() => setTypedRight(postcode.normal)}>
                  It&apos;s typed correctly
                </button>
                {offerDontKnow && (
                  <button type="button" className="confirm-postcode" onClick={dontKnowPostcode}>
                    I don&apos;t know my postcode
                  </button>
                )}
              </div>
            )}
            {isPostcode && !noPostcode && !errors[f.key] && postcode.needsConfirm && typedRight === postcode.normal && (
              <div className="confirm-row">
                <button
                  type="button"
                  className="confirm-postcode"
                  onClick={() => {
                    setConfirmed(postcode.normal);
                    report(values, postcode.normal);
                  }}
                >
                  Yes, my home is outside {check!.areaName}
                </button>
                <button
                  type="button"
                  className="confirm-postcode"
                  onClick={() => {
                    setTypedRight(null);
                    postcodeInput.current?.focus();
                  }}
                >
                  No — I&apos;ll check my postcode
                </button>
              </div>
            )}
            {isPostcode && offerDontKnow && !postcode.needsConfirm && (
              <button type="button" className="dont-know" onClick={dontKnowPostcode}>
                I don&apos;t know my postcode
              </button>
            )}
            {isStreet && matches.length > 0 && (
              <ul className="street-matches" aria-label="Streets that match">
                {matches.map((m) => (
                  <li key={`${m.street}|${m.area}|${m.outward}`}>
                    <button type="button" className="street-match" onClick={() => chooseStreet(m)}>
                      <span className="street-name">{m.street}</span>
                      <span className="street-area">
                        {m.area}
                        {m.outward ? ` · ${m.outward}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
