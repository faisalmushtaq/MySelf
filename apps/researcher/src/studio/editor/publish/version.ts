import { checkChosenVersion, nextVersion, type Bump } from "@myself/studio";

/**
 * The version a publisher may choose (docs/16 §5.1, docs/06 §3).
 *
 * The changes decide the smallest bump; the publisher may choose a larger one,
 * never a smaller one. Smaller ones are still shown — disabled, with the reason
 * — because "why can't this be a patch?" deserves an answer on screen, not a
 * missing option.
 */

export const BUMPS: readonly Bump[] = ["major", "minor", "patch"];

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export function atLeastBump(bump: Bump, required: Bump | null): boolean {
  return required === null || RANK[bump] >= RANK[required];
}

export function largerBump(a: Bump, b: Bump): Bump {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface VersionOption {
  bump: Bump;
  /** Without the "r", as the request carries it: "8.0.0". */
  version: string;
  title: string;
  /** What this kind of version is for. */
  meaning: string;
  allowed: boolean;
  /** Why a smaller bump than the changes need is not allowed. */
  reason: string | null;
  /** The smallest bump the changes allow — the default. */
  required: boolean;
}

const MEANING: Record<Bump, string> = {
  major: "Question changes: wording, options, codes, types, required, conditions or variables.",
  minor: "Wording outside the questions: start and completion screens, section titles.",
  patch: "Details participants never see.",
};

const TITLE: Record<Bump, string> = { major: "Major", minor: "Minor", patch: "Patch" };

/** Why a smaller bump than `required` is not allowed. */
export function tooSmallReason(required: Bump): string {
  if (required === "major") {
    return "These changes alter the questions, so they need a major version.";
  }
  return "These changes include wording participants see, which is never a patch.";
}

/**
 * The three choices after `latest`, or the one first version when nothing has
 * been published. Throws only on a corrupted `latest` (see `nextVersion`).
 */
export function versionOptions(latest: string | null, required: Bump | null): VersionOption[] {
  if (latest === null) {
    return [
      {
        bump: "major",
        version: nextVersion(null, "major"),
        title: "First version",
        meaning: "The survey's first published version.",
        allowed: true,
        reason: null,
        required: true,
      },
    ];
  }
  return BUMPS.map((bump) => {
    const allowed = atLeastBump(bump, required);
    return {
      bump,
      version: nextVersion(latest, bump),
      title: TITLE[bump],
      meaning: MEANING[bump],
      allowed,
      reason: allowed || required === null ? null : tooSmallReason(required),
      required: bump === (required ?? "patch"),
    };
  });
}

/** The choice to start from: the smallest the changes allow. */
export function defaultBump(required: Bump | null): Bump {
  return required ?? "patch";
}

export type ChoiceCheck = { ok: true; version: string } | { ok: false; message: string };

/**
 * Whether a choice may be published, with the same rule the server applies
 * (`checkChosenVersion`): a new number, above every published one, at least
 * the bump the changes need.
 */
export function checkChoice(latest: string | null, bump: Bump | null, required: Bump | null): ChoiceCheck {
  if (!bump) return { ok: false, message: "Choose a version number." };
  let version: string;
  try {
    version = nextVersion(latest, bump);
  } catch {
    return { ok: false, message: `The latest published version, “${latest}”, isn't a version number, so a new one can't be worked out. Tell the study's technical lead.` };
  }
  const check = checkChosenVersion(latest, version, required);
  if (check.ok) return { ok: true, version };
  switch (check.reason) {
    case "bump_too_small":
      return { ok: false, message: `${tooSmallReason(required ?? "patch")} The lowest version allowed is r${check.minimum}.` };
    case "not_greater":
      return { ok: false, message: `r${version} isn't above the latest published version. The lowest version allowed is r${check.minimum}.` };
    default:
      return { ok: false, message: `r${version} isn't a version number the Studio can publish.` };
  }
}
