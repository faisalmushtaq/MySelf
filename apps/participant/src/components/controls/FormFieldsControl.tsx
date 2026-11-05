import { useEffect, useMemo, useRef, useState } from "react";
import { normalisePostcode, splitHouse, type StreetList, type StreetMatch } from "@myself/engine";
import { postcodeList } from "../../lib/postcodes.js";
import { streetList as loadStreets } from "../../lib/streets.js";
import { truncateText } from "../../lib/text.js";
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
  // Or the search leads (D-80): the screen opens on one box, "Start typing your
  // address", and the fields appear once a street is chosen, filled in. A
  // return visit, with something already saved, opens on the fields.
  const searchFirst = streets?.searchFirst === true;
  const [searching, setSearching] = useState(searchFirst && !Object.values(current).some((x) => (x ?? "").trim()));
  const [addressText, setAddressText] = useState("");
  const [addressQuery, setAddressQuery] = useState("");
  const addressInput = useRef<HTMLInputElement | null>(null);
  const houseInput = useRef<HTMLInputElement | null>(null);
  const [noPostcode, setNoPostcode] = useState(
    streets !== undefined &&
      !searchFirst &&
      !(current[check!.field] ?? "").trim() &&
      Boolean(current[streets.areaKey] || current[streets.districtKey]),
  );
  /** Whether a typed street is matched against the list as it is typed. */
  const streetMode = noPostcode || searchFirst;
  const [streetList, setStreetList] = useState<StreetList | null>(null);
  const [streetQuery, setStreetQuery] = useState("");
  const streetInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!streetMode || !streets) return;
    let live = true;
    void loadStreets(streets.asset).then((l) => live && setStreetList(l));
    return () => {
      live = false;
    };
  }, [streetMode, streets?.asset]);
  // Searched a beat after typing stops, not on every keystroke.
  useEffect(() => {
    if (!streetMode || !streets) return;
    const t = setTimeout(() => setStreetQuery(values[streets.field] ?? ""), 250);
    return () => clearTimeout(t);
  }, [streetMode, streets?.field, values[streets?.field ?? ""]]);
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(() => setAddressQuery(addressText), 250);
    return () => clearTimeout(t);
  }, [searching, addressText]);
  // Back to the search from the fields, the box is ready to type in. Not on
  // arrival: the screen opens like any other, without raising the keyboard.
  const searchedBefore = useRef(false);
  useEffect(() => {
    if (searching && searchedBefore.current) addressInput.current?.focus();
    if (!searching) searchedBefore.current = true;
  }, [searching]);
  const chosenStreet = streets && values[streets.areaKey] !== undefined ? values : null;
  const matches = useMemo(
    () => (streetList && streetMode && !searching && !chosenStreet && streetQuery.trim() ? streetList.search(streetQuery, 5) : []),
    [streetList, streetMode, searching, chosenStreet, streetQuery],
  );
  /** What is typed in the search box, as a house part and a street to look for. */
  const typed = useMemo(() => splitHouse(addressQuery), [addressQuery]);
  const addressMatches = useMemo(
    () => (streetList && searching && typed.street.trim() ? streetList.search(typed.street, 6) : []),
    [streetList, searching, typed.street],
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
    const v = field ? truncateText(cleaned, field.maxChars) : cleaned;
    let next = { ...values, [key]: v };
    // Changing the street, or giving a postcode after all, undoes a match —
    // except where the search leads (D-80): there the postcode is an addition
    // to the street chosen, not instead of it.
    if (streets && (key === streets.field || (!searchFirst && key === check?.field && v.trim()))) next = withoutMatch(next);
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
    if (!searchFirst) streetInput.current?.focus();
  };

  const chooseStreet = (m: StreetMatch) => {
    if (!streets) return;
    apply({ ...values, [streets.field]: m.street, [streets.areaKey]: m.area, [streets.districtKey]: m.outward }, errors);
  };

  /** The text a field is cut to, as commit would cut it. */
  const fit = (key: string, v: string) => {
    if (item.responseType !== "form_fields") return v;
    const field = item.fields.find((f) => f.key === key);
    return field ? truncateText(v, field.maxChars) : v;
  };

  /**
   * What is typed in the search box is kept as it is typed, as the house and
   * street, so moving on without choosing from the list loses nothing; choosing
   * a street then adds its area and district (D-80).
   */
  const searchTyped = (text: string) => {
    if (!streets) return;
    setAddressText(text);
    const parts = splitHouse(text);
    const next: Record<string, string> = withoutMatch({ ...values, [streets.field]: fit(streets.field, parts.street) });
    if (item.fields.some((f) => f.key === "house")) next["house"] = fit("house", parts.house);
    apply(next, errors);
  };

  /** A street chosen from the search (D-80): the fields appear, filled in from it. */
  const chooseAddress = (m: StreetMatch) => {
    if (!streets) return;
    const house = splitHouse(addressText).house || (values["house"] ?? "");
    const next: Record<string, string> = { ...values, [streets.field]: m.street, [streets.areaKey]: m.area, [streets.districtKey]: m.outward };
    if (item.fields.some((f) => f.key === "house")) next["house"] = fit("house", house);
    apply(next, errors);
    setSearching(false);
    // Straight to whatever is still missing: the house, or else the postcode.
    setTimeout(() => (house ? postcodeInput.current : houseInput.current)?.focus(), 0);
  };

  /** The search did not find the street: the fields appear with what was typed (already kept), to finish by hand. */
  const typeInstead = () => {
    const house = splitHouse(addressText).house;
    setSearching(false);
    setTimeout(() => (house ? streetInput.current : houseInput.current)?.focus(), 0);
  };

  /** Back to the search box, for a different street. */
  const searchAgain = () => {
    if (!streets) return;
    setAddressText("");
    setAddressQuery("");
    setSearching(true);
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

  if (searching && streets && check) {
    const letters = typed.street.replace(/[^A-Za-z]/g, "").length;
    const note = !addressText.trim()
      ? "Start with your house number and street, like 12 Manor Drive."
      : streetList === null
        ? "Looking for your street…"
        : addressMatches.length > 0
          ? "Is it one of these? Tap your street."
          : letters >= 3
            ? `We can't find that street in ${check.areaName}. Check the spelling, or tap “My street isn't here”.`
            : "Keep typing your street.";
    return (
      <div className="fields">
        <div className="field-group">
          <label className="field">
            <span className="field-label">Start typing your address</span>
            <input
              type="text"
              inputMode="text"
              className="text-input address-search"
              maxLength={160}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={addressText}
              aria-describedby={`${item.key}-search-note`}
              ref={addressInput}
              onChange={(e) => searchTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                // Enter takes the only match there is; otherwise nothing is guessed.
                if (addressMatches.length === 1) chooseAddress(addressMatches[0]!);
              }}
            />
          </label>
          <p id={`${item.key}-search-note`} className="field-note" aria-live="polite">
            {note}
          </p>
          {addressMatches.length > 0 && (
            <ul className="street-matches" aria-label="Streets that match">
              {addressMatches.map((m) => (
                <li key={`${m.street}|${m.area}|${m.outward}`}>
                  <button type="button" className="street-match" onClick={() => chooseAddress(m)}>
                    <span className="street-name">{typed.house ? `${typed.house} ${m.street}` : m.street}</span>
                    <span className="street-area">
                      {m.area}
                      {m.outward ? ` · ${m.outward}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="dont-know" onClick={typeInstead}>
            {letters >= 3 ? "My street isn't here" : "Type my address in the boxes instead"}
          </button>
        </div>
      </div>
    );
  }

  /** Offered wherever the postcode is empty or unknown to the list, never once it is found. */
  const offerDontKnow =
    streets !== undefined && !noPostcode && (postcode.normal === null ? !(values[check!.field] ?? "").trim() || !!errors[check!.field] : postcode.needsConfirm);
  /** Where the search leads, the postcode is optional already: only an unknown one needs a way out. */
  const dontKnowLabel = searchFirst ? "I'm not sure of my postcode" : "I don't know my postcode";

  return (
    <div className="fields">
      {item.fields.map((f) => {
        const isPostcode = check !== undefined && f.key === check.field;
        const isStreet = streets !== undefined && f.key === streets.field;
        const noteId = `${item.key}-${f.key}-note`;
        const note = isPostcode
          ? noPostcode
            ? searchFirst
              ? "That's fine — you can leave it blank."
              : "That's fine — type your street below and choose it from the list."
            : !errors[f.key] && postcode.normal
              ? postcode.area
                ? `✓ ${postcode.area.ward}, ${postcode.area.district}`
                : postcode.needsConfirm
                  ? typedRight === postcode.normal
                    ? `Is your home outside ${check!.areaName}?`
                    : `We can't find ${postcode.normal} in ${check!.areaName}. Check it's typed correctly.`
                  : `✓ Kept as you gave it — outside ${check!.areaName}`
              : null
          : isStreet && streetMode
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
                ref={isPostcode ? postcodeInput : isStreet ? streetInput : f.key === "house" ? houseInput : undefined}
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
            {(isPostcode || (isStreet && streetMode)) && (
              // Said back, not shouted: the area a postcode lies in, or a request to
              // check one the list does not know (D-52); the street found (D-53).
              <p id={noteId} className="field-note" aria-live="polite">
                {note}
              </p>
            )}
            {isStreet && searchFirst && (
              <button type="button" className="dont-know" onClick={searchAgain}>
                Search for my street again
              </button>
            )}
            {isPostcode && !noPostcode && !errors[f.key] && postcode.needsConfirm && typedRight !== postcode.normal && (
              <div className="confirm-row">
                <button type="button" className="confirm-postcode" onClick={() => setTypedRight(postcode.normal)}>
                  It&apos;s typed correctly
                </button>
                {offerDontKnow && (
                  <button type="button" className="confirm-postcode" onClick={dontKnowPostcode}>
                    {dontKnowLabel}
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
            {isPostcode && offerDontKnow && !postcode.needsConfirm && !searchFirst && (
              <button type="button" className="dont-know" onClick={dontKnowPostcode}>
                {dontKnowLabel}
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
