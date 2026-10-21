import type { ProvenanceInput } from "@myself/schema";

/**
 * Where every questionnaire and module in the library came from (D-68), in
 * one place so the team can check them together. Written from the
 * repository's own record (the QSF audit in docs/01, the anomaly report in
 * docs/02 and the decisions in docs/09). Nothing here is guessed: what the
 * record does not say is written as not known, and every entry stays
 * unconfirmed until someone on the research team has checked it.
 *
 * To confirm an entry, set `confirmed: true`, `confirmedBy` (a name or role,
 * never an email) and `confirmedAt`; to record co-production, add an
 * `involvement` line (group, what they did, when).
 */

const QSF = "The YBM 2026 Qualtrics survey (NotreDame2026 QSF), encoded into the library in 2026.";
const QSF_UNKNOWN =
  "The survey file does not record who first wrote these questions, or whether any were taken from elsewhere. To confirm with the team that wrote the 2026 survey.";
const TEAM = "YBM research team";

export const LIBRARY_PROVENANCE: Record<string, ProvenanceInput> = {
  // --- Validated instruments --------------------------------------------------
  kss: {
    kind: "validated",
    basedOn: "Karolinska Sleepiness Scale (Åkerstedt & Gillberg, 1990).",
    adaptations:
      "The canonical form uses the published labels (D-08). The 2026 Qualtrics survey's labels differed (A-8); that form is kept as the 'ybm-asadmin' variant for the answers already collected with it.",
    evidence: "Published validation (Åkerstedt & Gillberg, 1990).",
    decisions: ["D-08"],
  },
  sqs: {
    kind: "validated",
    basedOn: "Sleep Quality Scale, single item (Snyder et al., 2018).",
    adaptations: "Laid out as one row of 0–10 boxes with the published bands beneath (presentation only).",
    evidence: "Validated by Snyder et al. (2018) in adults with chronic insomnia and depression; not, as far as the record shows, in children or adolescents.",
    decisions: ["D-53"],
  },
  ehi_sf: {
    kind: "validated_adapted",
    basedOn: "Edinburgh Handedness Inventory – Short Form (Veale, 2014), from Oldfield (1971).",
    adaptations:
      "Version 2.0 asks each item as a question ('Which hand do you write with?') instead of naming the task, and shows a picture of the object (D-19, D-32). Response options and codes are Veale's. The 2026 Qualtrics form (left-anchored, A-19) is kept as the 'ybm-asadmin' variant.",
    evidence: "Published validation of the short form (Veale, 2014); the question wording used here has not been validated.",
    decisions: ["D-08", "D-19", "D-32"],
  },
  macarthur_ssy: {
    kind: "validated_adapted",
    basedOn: "MacArthur Scale of Subjective Social Status – Youth Version (Goodman et al., 2001).",
    adaptations:
      "Discrete 10-rung ladders (D-08); the explanation sits with each ladder on one screen (D-23). Revision 2 (October 2026): the research team reworded both ladder explanations and the school ladder's rung labels. Codes and anchors are unchanged.",
    evidence: "Published validation (Goodman et al., 2001); the reworded explanations have not been validated.",
    decisions: ["D-08", "D-23", "D-62"],
  },
  macarthur_sss_adult: {
    kind: "validated",
    basedOn: "MacArthur Scale of Subjective Social Status – Adult Version, society and community ladders (Adler et al., 2000).",
    adaptations: "Wording as supplied by the social media break study team. Not yet checked word for word against the published version.",
    evidence: "Published validation (Adler et al., 2000).",
    involvement: [{ group: "Social media break study team", role: "supplied the wording", when: "2026-10" }],
    decisions: ["D-65"],
  },
  phq4: {
    kind: "validated",
    basedOn: "Patient Health Questionnaire-4 (Kroenke et al., 2009): GAD-2 and PHQ-2.",
    evidence: "Published validation (Kroenke et al., 2009; Löwe et al., 2010) in adults.",
    involvement: [{ group: "Social media break study team", role: "asked for it and supplied the items and reference", when: "2026-10" }],
    decisions: ["D-65"],
  },
  swemwbs: {
    kind: "validated",
    basedOn: "Short Warwick–Edinburgh Mental Wellbeing Scale (Stewart-Brown et al., 2009).",
    evidence: "Published validation (Stewart-Brown et al., 2009).",
  },
  sdq25_s: {
    kind: "validated",
    basedOn: "Strengths and Difficulties Questionnaire, self-report for ages 11–17 (Goodman, 1997; youthinmind).",
    adaptations:
      "None in the canonical form, which is the S11-17 word for word (D-51). The 2026 Qualtrics form used a different anchor ('Clearly true', A-6) and is kept as the 'ybm-asadmin' variant.",
    evidence: "Published validation (Goodman, 1997, and later work).",
    decisions: ["D-08", "D-51"],
  },
  sdq25_s18: {
    kind: "validated_adapted",
    basedOn: "Strengths and Difficulties Questionnaire, self-report for those aged 18 and over (S18+, youthinmind).",
    adaptations: "Item 22 names school or college and university as well as work (D-52). Everything else is the S18+ word for word.",
    evidence: "youthinmind's 4–17 cut-points have not been validated for the 18+ form; report continuous scores.",
    decisions: ["D-51", "D-52"],
  },
  rcads25: {
    kind: "validated",
    basedOn: "Revised Child Anxiety and Depression Scale – 25-item short version (Ebesutani et al., 2012).",
    adaptations: "None. Item 17 was put back to its published wording (D-62).",
    evidence: "Published validation (Ebesutani et al., 2012).",
    decisions: ["D-62"],
  },
  stai5_s: {
    kind: "validated",
    basedOn: "STAI-5, state anxiety short form (Zsido et al., 2020), from Spielberger's STAI.",
    evidence: "Published validation (Zsido et al., 2020).",
  },
  bisbas12_ybm: {
    kind: "validated_adapted",
    basedOn: "BIS/BAS Scales (Carver & White, 1994).",
    adaptations:
      "A 12-item subset (BIS 4, Reward Responsiveness 4, Drive 4; Fun Seeking left out), as in the 2026 Qualtrics survey (A-22). Who chose the subset, and whether it was used before (possibly in the 'AoW' study), is not recorded.",
    evidence: "The full scales are validated (Carver & White, 1994); this subset has not been, as far as the record shows.",
    decisions: ["D-07"],
  },
  doomscroll4: {
    kind: "validated_adapted",
    basedOn: "Probably a short subset of the Doomscrolling Scale (Sharma, Lee & Johnson, 2022). Not verified (A-23).",
    adaptations: "Four items, 7-point, disagree first, as in the 2026 Qualtrics survey.",
    evidence: "Which published items these are, and whether a 4-item subset has been validated, is not verified.",
    notes: "A-23: citation and permission still to be checked.",
  },

  // --- Modules ----------------------------------------------------------------
  ybm_intro_consent: {
    kind: "researcher_developed",
    developedBy: TEAM,
    basedOn: `${QSF} The information and consent text is the ethics-approved text (PSCETHS-1449).`,
    adaptations:
      "One consent statement corrected ('shown at the start of this survey', D-23); Connected Yorkshire linkage explained and made a condition of taking part (D-53, D-58); 'Why your answers matter' worded by the research team (October 2026, D-62).",
    decisions: ["D-06", "D-23", "D-53", "D-58", "D-62"],
  },
  ybm_identity: {
    kind: "researcher_developed",
    developedBy: TEAM,
    basedOn: QSF,
    adaptations: "Name, date of birth and home address in place of the 2026 secret code (D-52); kept apart from the answers (D-09).",
    decisions: ["D-09", "D-23", "D-52"],
  },
  ybm_demographics: {
    kind: "researcher_developed",
    developedBy: TEAM,
    basedOn: `${QSF} The ethnicity list follows the UK census categories.`,
    adaptations:
      "Ethnicity options in order of how common they are in West Yorkshire (Census 2021, D-53); questions on languages added by the research team (D-53, D-58).",
    notes: QSF_UNKNOWN,
    decisions: ["D-07", "D-53", "D-58"],
  },
  ybm_eeg_practical: { kind: "researcher_developed", developedBy: TEAM, basedOn: QSF, notes: QSF_UNKNOWN },
  ybm_sleep_priorities: { kind: "researcher_developed", developedBy: TEAM, basedOn: QSF, notes: QSF_UNKNOWN },
  ybm_smartphone: {
    kind: "researcher_developed",
    developedBy: TEAM,
    basedOn: QSF,
    adaptations: "Typo fixed (D-07); age 5 added to both age lists (D-04).",
    notes: QSF_UNKNOWN,
    decisions: ["D-04", "D-07"],
  },
  ybm_social_media: {
    kind: "existing_items",
    basedOn:
      "The 2026 Qualtrics survey's social media block, titled there 'adapted from AoW'. Which study 'AoW' is, and what exactly was adapted, is not recorded.",
    adaptations:
      "Per-platform time stepped into one question each, with the Twitch condition corrected (D-02); abstain-effect wording restored (D-01); family-control follow-ups written by the research team (D-53).",
    notes: "To confirm: the AoW source, with a citation, and what the 2026 team changed from it.",
    decisions: ["D-01", "D-02", "D-53"],
  },
  ybm_ai_use: {
    kind: "researcher_developed",
    developedBy: TEAM,
    evidence: "None yet; there is no short validated measure of adolescents' AI use (D-59).",
    decisions: ["D-59"],
  },
  ybm_screen_attitudes: { kind: "researcher_developed", developedBy: TEAM, basedOn: QSF, notes: QSF_UNKNOWN, decisions: ["D-07"] },
  ybm_gaming: { kind: "researcher_developed", developedBy: TEAM, basedOn: QSF, notes: QSF_UNKNOWN, decisions: ["D-03"] },
  ybm_future_self: { kind: "researcher_developed", developedBy: TEAM, basedOn: QSF, notes: QSF_UNKNOWN, decisions: ["D-15"] },
  ybm_app_time: {
    kind: "researcher_developed",
    developedBy: TEAM,
    involvement: [{ group: "Social media break study team", role: "asked for a per-app hours and minutes grid", when: "2026-10" }],
    evidence: "None yet.",
    decisions: ["D-66"],
  },
  ybm_sm_patterns: {
    kind: "researcher_developed",
    developedBy: TEAM,
    involvement: [{ group: "YBM research team", role: "named the phenotype domains the questions should cover", when: "2026-10" }],
    evidence:
      "None yet; study-written and exploratory. A literature check (October 2026, docs/09 D-68) found no validated measure of time-of-day pattern or of scrolling past or speeding up content.",
    notes:
      "Related published measures, from the literature check (not yet read by the team): night-time use, Scott & Woods (2018) J Adolescence 68:61-65; checking without a purpose, the Smartphone Use Questionnaire – Absent-Minded (SUQ-A), Marty-Dugas et al. (2018) doi:10.1037/cns0000131, adults only; media multitasking in adolescents, MMM-S, Baumgartner et al. (2017) doi:10.1027/1864-1105/a000167.",
    decisions: ["D-67", "D-68"],
  },
  ybm_phone_pickups: {
    kind: "researcher_developed",
    developedBy: TEAM,
    involvement: [{ group: "YBM research team", role: "named the phenotype domains the questions should cover", when: "2026-10" }],
    evidence:
      "Study-written. The phone's own count is asked because estimates of phone use agree poorly with logged use: Andrews et al. (2015) doi:10.1371/journal.pone.0139004; Ellis et al. (2019) doi:10.1016/j.ijhcs.2019.05.004; Parry et al. (2021) doi:10.1038/s41562-021-01117-5; Ohme et al. (2021) doi:10.1177/2050157920959106 (Screen Time screenshots).",
    decisions: ["D-67", "D-68"],
  },
};

/**
 * Questions whose origin differs from their module's: added by the research
 * team to a module that came from the 2026 survey.
 */
const added = (decisions: string[], notes?: string): ProvenanceInput => ({
  kind: "researcher_developed",
  developedBy: TEAM,
  decisions,
  ...(notes ? { notes } : {}),
});

export const QUESTION_PROVENANCE: Record<string, Record<string, ProvenanceInput>> = {
  ybm_intro_consent: { why_it_matters: added(["D-62"], "Wording by the research team, October 2026.") },
  ybm_identity: { home_address: added(["D-52"]) },
  ybm_social_media: { family_control_how: added(["D-53"]), family_control_other: added(["D-53"]) },
  ybm_smartphone: { sm_use_confirm: added(["D-26"]) },
  ybm_sm_patterns: {
    unintended_open: added(
      ["D-67", "D-68"],
      "Close to the SUQ-A's 'check your phone without a purpose' and 'out of habit' (Marty-Dugas et al., 2018). Adapting the SUQ-A would give a published source; it was validated in adults only.",
    ),
    mindless: added(["D-67", "D-68"], "Overlaps the SUQ-A in part (Marty-Dugas et al., 2018)."),
    multitask: added(["D-67", "D-68"], "Overlaps media multitasking; the MMM-S (Baumgartner et al., 2017) is validated in adolescents."),
  },
};

/** The demographics questions the 2026 survey had; the rest are the languages questions (D-53, D-58). */
const DEMOGRAPHICS_FROM_QSF = new Set(["ethnicity", "gender", "medication"]);

type Def = {
  instrument: string;
  provenance?: ProvenanceInput | undefined;
  forms: { items: { key: string; provenance?: ProvenanceInput | undefined }[] }[];
};

/** Give each definition its record. A definition without one is a mistake, so it fails loudly. */
export function attachProvenance<T extends { instrument: string }>(defs: T[]): T[] {
  for (const def of defs as unknown as Def[]) {
    const record = LIBRARY_PROVENANCE[def.instrument];
    if (!record) throw new Error(`No provenance recorded for ${def.instrument} (packages/library/src/provenance.ts).`);
    def.provenance = record;
    const questions = QUESTION_PROVENANCE[def.instrument] ?? {};
    for (const form of def.forms) {
      for (const item of form.items) {
        const own = questions[item.key];
        if (own) item.provenance = own;
        else if (def.instrument === "ybm_demographics" && !DEMOGRAPHICS_FROM_QSF.has(item.key)) item.provenance = added(["D-53", "D-58"]);
      }
    }
  }
  return defs;
}
