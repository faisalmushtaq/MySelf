import type { ReactNode } from "react";
import type { ReleaseManifest } from "@myself/schema";
import type { AccessibilityPreferences } from "../lib/accessibility.js";
import type { StoredSessionCounts } from "../lib/db.js";
import { EVICTION_CAP_DAYS, type Durability } from "../lib/durability.js";
import type { ReleaseOrigin } from "../lib/versions.js";

/**
 * Where the running version came from, in a word or two for the build line.
 * Staff read it before handing the iPad over, to see which version a sitting
 * will be collected under (D-54).
 */
const ORIGIN_LABEL: Record<ReleaseOrigin, string> = {
  active: "live",
  stored: "live when last checked",
  bundled: "built in",
  resumed: "finishing a sitting",
  preview: "draft",
};

/**
 * The neutral screen an iPad sits on between participants: the study code,
 * reading settings, and — for staff — the build line and the handover panel.
 *
 * Everything it shows comes from App, and everything it changes goes back
 * through a callback, so a sitting that starts and ends in between leaves the
 * code, the settings and an open handover panel exactly as they were.
 */
export interface StartScreenProps {
  /** The release's short label for participants ("Notre Dame · 2026"), if it has one. */
  studyLabel: string | undefined;
  /** The release's rule for the study code: its format, label and instructions. */
  codeRule: ReleaseManifest["composition"]["participantCode"];
  /** Ethics reference and contact address, shown quietly at the foot. */
  contact: ReleaseManifest["composition"]["contact"];
  releaseVersion: string;
  releaseHash: string | undefined;
  /** How this device came to be running this version. */
  releaseOrigin: ReleaseOrigin;
  /** Why the live version is not the one running, when that is the case. */
  releaseNote: string | undefined;
  code: string;
  codeError: string | null;
  onCodeChange: (code: string) => void;
  onCodeErrorClear: () => void;
  /** A start is under way, so Start cannot be pressed twice. */
  busy: boolean;
  onStart: () => Promise<void>;
  accessibility: AccessibilityPreferences;
  onAccessibilityChange: (patch: Partial<AccessibilityPreferences>) => void;
  durability: Durability | null;
  counts: StoredSessionCounts;
  /** A tap on the build line; App counts them to open the handover panel. */
  onBuildLineTap: () => void;
  /** The handover panel, when it is open. It sits below the build line. */
  children?: ReactNode;
}

export function StartScreen({
  studyLabel,
  codeRule,
  contact,
  releaseVersion,
  releaseHash,
  releaseOrigin,
  releaseNote,
  code,
  codeError,
  onCodeChange,
  onCodeErrorClear,
  busy,
  onStart,
  accessibility,
  onAccessibilityChange,
  durability,
  counts,
  onBuildLineTap,
  children,
}: StartScreenProps) {
  return (
    <div className="screen start">
      <h1 className="brand">MySelf</h1>
      <p className="subbrand">MyThoughts</p>
      {studyLabel && <p className="study-title">{studyLabel}</p>}
      {/* The code the research team issued, entered once before anything
          else. It used to be asked again mid-survey; now it is captured
          here and carried through, so nobody types it twice. */}
      {codeRule?.instructions && <p className="start-instructions">{codeRule.instructions}</p>}
      <label className="field code-field">
        <span className="field-label">{codeRule?.label ?? "Your participant code"}</span>
        <input
          className="text-input code"
          value={code}
          placeholder={codeRule?.placeholder ?? "NDC0000"}
          autoCapitalize="characters"
          autoComplete="off"
          aria-invalid={codeError !== null}
          maxLength={16}
          onChange={(e) => {
            // Codes are letters and digits only; punctuation and spaces
            // are dropped as they are typed rather than rejected later.
            onCodeChange(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16));
            if (codeError) onCodeErrorClear();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onStart();
          }}
        />
        {codeError && (
          <span className="error" role="alert">
            {codeError}
          </span>
        )}
      </label>
      <button type="button" className="next big" disabled={code.trim().length < 2 || busy} onClick={() => void onStart()}>
        Start
      </button>
      <details className="reading-settings">
        <summary>Reading settings</summary>
        <p className="reading-settings-intro">Choose the display that feels clearest. These preferences stay on this device and are never included in study data.</p>
        <div className="reading-settings-row">
          <span className="reading-settings-label">Text size</span>
          <div className="reading-settings-options" role="group" aria-label="Text size">
            {(["default", "large", "extra_large"] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={`reading-settings-choice ${accessibility.textSize === size ? "selected" : ""}`}
                aria-pressed={accessibility.textSize === size}
                onClick={() => onAccessibilityChange({ textSize: size })}
              >
                {size === "default" ? "Default" : size === "large" ? "Large" : "Extra large"}
              </button>
            ))}
          </div>
        </div>
        <div className="reading-settings-row">
          <span className="reading-settings-label">Contrast</span>
          <div className="reading-settings-options" role="group" aria-label="Contrast">
            {(["standard", "high", "dark"] as const).map((contrast) => (
              <button
                key={contrast}
                type="button"
                className={`reading-settings-choice ${accessibility.contrast === contrast ? "selected" : ""}`}
                aria-pressed={accessibility.contrast === contrast}
                onClick={() => onAccessibilityChange({ contrast })}
              >
                {contrast === "standard" ? "Standard" : contrast === "high" ? "High" : "Dark"}
              </button>
            ))}
          </div>
        </div>
        <label className="reading-settings-toggle">
          <input
            type="checkbox"
            checked={accessibility.dyslexiaFriendly}
            onChange={(event) => onAccessibilityChange({ dyslexiaFriendly: event.target.checked })}
          />
          <span>Dyslexia-friendly reading mode</span>
        </label>
      </details>
      {/*
        Addressed to whoever set this iPad up, on the screen they are looking at
        when they do it — because the one action that prevents the loss has to be
        taken before any data exists, and the panel that explains it is behind a
        five-tap gesture only a researcher knows. It sits with the build line,
        which is already staff-facing text on this screen, and it disappears the
        moment either protection is in place.
      */}
      {durability?.atRisk && (
        <p className="hint warn setup-note">
          Before using this iPad for real sittings: tap Share, then <strong>Add to Home Screen</strong>, and open MySelf from there. Safari deletes a website's saved data after {EVICTION_CAP_DAYS} days of not being opened; an app on the Home Screen keeps it.
        </p>
      )}
      <p className="hint demo-note" onClick={() => onBuildLineTap()}>
        Preview build · release {releaseVersion} ({ORIGIN_LABEL[releaseOrigin]}) · {releaseHash?.slice(7, 19)} ·{" "}
        {releaseNote && <>{releaseNote} · </>}
        {counts.awaitingSync + counts.syncFailed} session{counts.awaitingSync + counts.syncFailed === 1 ? "" : "s"} awaiting sync · {counts.syncedVerified} verified · build{" "}
        {__BUILD_STAMP__}
      </p>
      {children}
      {contact && (
        <p className="start-footer">
          {contact.ethicsReference && <>Ethics reference {contact.ethicsReference}. </>}
          Any questions, email <a href={`mailto:${contact.email}`}>{contact.email}</a>.
          {contact.note && <> {contact.note}</>}
        </p>
      )}
    </div>
  );
}
