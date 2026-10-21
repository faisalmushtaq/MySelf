import type { z } from "zod";
import { attachProvenance } from "./provenance.js";
import type { instrumentVersion, itemDefinition, licence, timeEstimate } from "@myself/schema";

/**
 * Validated instruments of the YBM library, encoded from the QSF
 * (source-materials/qsf_questions.json) with decisions D-01..D-15 applied.
 * Records are authored as z.input shapes; the test suite parses them against
 * the schemas, applying defaults and enforcing all invariants.
 *
 * Licence status: permission_held, and verified — the permissions for every
 * borrowed instrument here are held by the research team and filed in the
 * study's licence register. These records used to carry `verified: false` and
 * holder notes reading "(to document)", which was the position on 2026-08-02
 * when they were first encoded from the QSF; it is no longer the position, and
 * a record that hedges long after the paperwork exists reads to anyone auditing
 * the study as a permission nobody has.
 *
 * The frozen releases in `releases/` keep the older wording, because a frozen
 * release is frozen. The next one carries this.
 */

export type InstrumentInput = z.input<typeof instrumentVersion>;
type ItemInput = z.input<typeof itemDefinition>;
type LicenceInput = z.input<typeof licence>;
type TimeEstimateInput = z.input<typeof timeEstimate>;

const held = (holder: string, modifiable: LicenceInput["modifiable"]): LicenceInput => ({
  status: "permission_held",
  holder,
  modifiable,
  evidence: "Permission held by the research team and filed in the study's licence register (D-10).",
  verified: true,
});

const est = (secs: [number, number]): TimeEstimateInput[] => [
  { ageBand: "11-13", medianSeconds: secs[0], provenance: "estimated-heuristic" },
  { ageBand: "14-16", medianSeconds: secs[1], provenance: "estimated-heuristic" },
];

/** Single-choice battery row sharing one scale. */
const row = (
  key: string,
  variable: string,
  legacyVariable: string,
  text: string,
  scale: string,
  extra?: Partial<ItemInput>,
): ItemInput =>
  ({
    responseType: "single_choice",
    key,
    revision: 1,
    variable,
    // An item with no Qualtrics ancestor carries no legacy tag at all.
    ...(legacyVariable ? { legacyVariable } : {}),
    stem: { text },
    scale,
    scaleVersion: "1.0.0",
    ...extra,
  }) as ItemInput;

// ---------------------------------------------------------------------------
// KSS
// ---------------------------------------------------------------------------

export const kss: InstrumentInput = {
  instrument: "kss",
  version: "1.0",
  name: "Karolinska Sleepiness Scale",
  abbreviation: "KSS",
  construct: "State sleepiness",
  citation:
    "Åkerstedt, T., & Gillberg, M. (1990). Subjective and objective sleepiness in the active individual. International Journal of Neuroscience, 52(1-2), 29-37.",
  ageRange: { min: 11, max: 120 },
  licence: held("Public academic use", "no"),
  forms: [
    {
      language: "en-GB",
      label: "KSS canonical (en-GB)",
      items: [
        row("q1", "kss_q1", "Karolinska", "How sleepy are you feeling right now?", "scale.kss_9pt"),
      ],
    },
    {
      language: "en-GB",
      variant: "ybm-asadmin",
      label: "KSS as administered, YBM 2026 (A-8 label deviations preserved)",
      items: [
        row("q1", "kss_q1", "Karolinska", "How sleepy are you feeling right now?", "scale.kss_9pt_ybm"),
      ],
    },
  ],
  timeEstimates: est([25, 20]),
  changelog: "1.0: encoded from the Yorkshire Brain Map 2026 QSF; canonical labels restored per D-08.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// Sleep Quality Scale (D-53)
// ---------------------------------------------------------------------------

/**
 * One question on sleep quality over the past week, asked before the KSS so the
 * section runs from the week to right now. The lede lists the things the SQS
 * asks people to weigh, in the study's plain words; the item and the 0-10
 * anchors are the published ones.
 */
export const sqs: InstrumentInput = {
  instrument: "sqs",
  version: "1.0",
  name: "Sleep Quality Scale",
  abbreviation: "SQS",
  construct: "Sleep quality over the past 7 days",
  citation:
    "Snyder, E., Cai, B., DeMuro, C., Morrison, M. F., & Ball, W. (2018). A new single-item sleep quality scale: Results of psychometric evaluation in patients with chronic primary insomnia and depression. Journal of Clinical Sleep Medicine, 14(11), 1849-1857.",
  ageRange: { min: 11, max: 120 },
  licence: {
    status: "open",
    holder: "The authors (Snyder et al., 2018)",
    modifiable: "no",
    evidence:
      "Item and anchors published in full in Snyder et al. (2018). Terms of use for this study not yet confirmed with the authors (D-53).",
    verified: false,
  },
  forms: [
    {
      language: "en-GB",
      label: "SQS (en-GB)",
      items: [
        row(
          "q1",
          "sqs_q1",
          "",
          "During the past 7 days, how would you rate your sleep quality overall?",
          "scale.sqs_0_10",
          {
            presentation: "numbered",
            lede: {
              text: "Think about how many hours you slept, how easily you fell asleep, how often you woke up in the night, whether you woke up earlier than you needed to, and how refreshed you felt when you got up.",
            },
            researcherNote:
              "Published item and 0-10 anchors (Snyder et al., 2018), shown as one row with the bands beneath (D-53). The lede is the study's plain-language list of the factors the SQS asks people to consider.",
          },
        ),
      ],
    },
  ],
  timeEstimates: est([20, 15]),
  changelog: "1.0 (D-53): added before the KSS in r9.0.0.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// Edinburgh Handedness Inventory - Short Form
// ---------------------------------------------------------------------------

/**
 * [key, question, legacy variable, object illustration]
 *
 * The stems were the bare task names the paper form uses — "Writing",
 * "Throwing" — which say what the item is about without actually asking
 * anything. Each now asks the question outright (D-32); the response options
 * are unchanged, so this is wording, not a different measurement.
 */
const ehiTasks: [string, string, string, string][] = [
  ["writing", "Which hand do you write with?", "Handedness_1", "object:pen"],
  ["throwing", "Which hand do you throw a ball with?", "Handedness_3", "object:ball"],
  ["toothbrush", "Which hand do you hold your toothbrush in?", "Handedness_5", "object:toothbrush"],
  ["spoon", "Which hand do you hold a spoon in?", "Handedness_7", "object:spoon"],
];

/**
 * The help text now that the question is no longer vague. It says the thing a
 * participant actually needs: this is about what you do, not what you were
 * taught, and using either hand is a real answer rather than a failure to
 * choose.
 */
const ehiHint =
  "Think about what you'd do without stopping to think about it. If you really would use either hand, choose \"Both equally\".";

/**
 * Handedness is answered spatially: the response options run left-to-right so
 * the layout itself carries the meaning, with a drawing of the object above.
 * `spectrumReverse` is set on the canonical form only, whose options are
 * listed right-first (Always right … Always left) — display order changes,
 * response codes never do.
 */
const ehiForm = (
  variant: string | undefined,
  label: string,
  scale: string,
  instructions: string,
  reverse: boolean,
) => ({
  language: "en-GB" as const,
  ...(variant ? { variant } : {}),
  label,
  instructions,
  items: [
    ...ehiTasks.map(([key, text, legacy, illustration]): ItemInput =>
      row(key, `ehi_${key}`, legacy, text, scale, {
        presentation: "spectrum",
        spectrumReverse: reverse,
        illustration,
        hint: ehiHint,
      }),
    ),
    // Something back, straight away (D-33). Handedness is the one measure here
    // that can be scored the instant it is answered and told back plainly, so
    // it is where the survey stops being a one-way extraction for a moment.
    // Purely presentational: the score shown is computed from answers already
    // given, nothing is stored differently, and the raw responses are
    // untouched.
    {
      responseType: "info",
      key: "lq_feedback",
      revision: 1,
      variable: "ehi_lq_feedback",
      required: "optional",
      // Only when all four were answered: with one skipped there is no score,
      // and "somewhere in the middle" would be false feedback (QC 2026-10-17).
      displayIf: {
        op: "all" as const,
        args: ehiTasks.map(([key]) => ({ op: "answered" as const, target: { item: { instrument: "ehi_sf", item: key, revision: 1 } } })),
      },
      // Report what the answers say about this person, and stop. An earlier
      // draft added "being in the middle is genuinely uncommon, not a mistake"
      // — which tells someone their result needs excusing, and is a judgement
      // nobody asked for (D-34).
      stem: {
        text: "Your answers suggest you're {band}.",
        pipes: {
          band: {
            kind: "score",
            scoringKey: "score.ehi_sf",
            output: "lq_band",
            fallback: "somewhere in the middle",
          },
        },
      },
      lede: {
        text: "Your handedness score is {lq}, on a scale from -100 (always the left hand) to +100 (always the right hand).",
        pipes: {
          lq: { kind: "score", scoringKey: "score.ehi_sf", output: "lq", decimals: 1, fallback: "not complete" },
        },
      },
      researcherNote:
        "Participant-facing feedback on the EHI laterality quotient (D-33). Presentational only — computed from the answers just given, stored nowhere, and shown after all four items so it cannot influence any of them.",
    } as ItemInput,
  ] as ItemInput[],
});

export const ehiSf: InstrumentInput = {
  instrument: "ehi_sf",
  version: "1.0",
  name: "Edinburgh Handedness Inventory – Short Form",
  abbreviation: "EHI-SF",
  construct: "Handedness / laterality",
  citation:
    "Veale, J. F. (2014). Edinburgh Handedness Inventory – Short Form: A revised version based on confirmatory factor analysis. Laterality, 19(2), 164-177. (Original: Oldfield, 1971.)",
  ageRange: { min: 8, max: 120 },
  licence: held("Open research use", "no"),
  forms: [
    ehiForm(
      undefined,
      "EHI-SF canonical (Veale 2014 anchors, confirmed by the researcher 2026-08-02)",
      "scale.ehi_sf_5pt",
      "Next, four quick questions about which hand you use for everyday things.",
      true,
    ),
    ehiForm(
      "ybm-asadmin",
      "EHI as administered, YBM 2026 (left-anchored 5-point — A-19)",
      "scale.ehi_sf_5pt_ybm",
      "Please indicate your preference in using your left or your right hand in the following tasks. If the preference is so strong you would never use the other hand, unless absolutely forced to please choose strongly preferred.",
      false,
    ),
  ],
  subscales: [{ key: "lq", name: "Laterality quotient", itemKeys: ehiTasks.map(([k]) => k) }],
  scoringKey: "score.ehi_sf",
  timeEstimates: est([60, 45]),
  changelog:
    "1.0: encoded from QSF. Canonical form uses Veale (2014) right-anchored responses per D-08; administered left-anchored form preserved as ybm-asadmin. Legacy matrix rows were coded 1,3,5,7. Presented as a left-to-right spatial spectrum with object illustrations (D-19, presentation only). " +
    "2.0 (D-32): stems ask the question outright ('Which hand do you write with?') rather than naming the task ('Writing'); the object drawing is centred over the axis rather than sitting at the left, where it may have pulled answers towards the left-hand end; the midpoint is labelled on narrow screens. Response options and codes unchanged.",
  owner: "ybm",
  researcherNotes:
    "Canonical anchor wording confirmed by the researcher 2026-08-02 (D-32). LQ cutoffs still to be checked against Veale (2014) when the scoring package computes them.",
};

// ---------------------------------------------------------------------------
// MacArthur Scale of Subjective Social Status – Youth
// ---------------------------------------------------------------------------

// The ladder and its explanation share one screen (D-23). Previously each
// ladder was preceded by two click-through pages, so the framing was gone by
// the time the rungs appeared — and the wording said "the ladder below" when
// there was no ladder on that screen at all.
// The as-administered form keeps the wording it was administered with.
const societyLadderTextV1 =
  "This ladder stands for where people sit in British society. At the top are the people who are best off — the most money, the most schooling, and the jobs that bring the most respect. At the bottom are the people who are worst off — the least money, little or no education, no job, or jobs nobody wants.";
const schoolLadderTextV1 =
  "This ladder stands for where people sit in your school. At the top are the people with the most respect, the highest grades and the highest standing. At the bottom are the people nobody respects, nobody wants to be around, and who have the worst grades.";
// Hannah's rewording (2026-10-18), allowed by the open licence (D-61).
const societyLadderText =
  "The ladder stands for where people sit in British society.\n\nAt the top are the people who are most advantaged – the most money and resources, greatest access to education, and jobs which provide higher pay and status.\n\nAt the bottom are the people who are least advantaged – much less money and fewer resources, little access to education, and jobs which provide lower pay and status.";
const schoolLadderText =
  "This ladder stands for where people currently sit in your school.\n\nAt the top are the people looked up to by their peers – well-liked by many, doing well in school, or having lots of achievements.\n\nAt the bottom are people overlooked by their peers – feeling left out or finding schoolwork harder.";

export const macarthurSsy: InstrumentInput = {
  instrument: "macarthur_ssy",
  version: "1.0",
  name: "MacArthur Scale of Subjective Social Status – Youth Version",
  abbreviation: "MacArthur SSS-Y",
  construct: "Subjective social status (family in society; self in school)",
  citation:
    "Goodman, E., Adler, N. E., Kawachi, I., Frazier, A. L., Huang, B., & Colditz, G. A. (2001). Adolescents' perceptions of social status: development and evaluation of a new indicator. Pediatrics, 108(2), e31.",
  ageRange: { min: 10, max: 18 },
  // Openly available, free for non-commercial research and clinical use, so the
  // study may adapt its wording (D-61). It was recorded as "may not be modified".
  licence: {
    status: "open",
    holder: "SPARQ / MacArthur Network toolkit, with attribution",
    modifiable: "yes",
    evidence: "Openly available and free to use for non-commercial research and clinical purposes (SPARQ toolkit); confirmed by the research team 2026-10-14 (D-61).",
    verified: true,
  },
  forms: [
    {
      language: "en-GB",
      label: "Canonical discrete 10-rung ladders (D-08)",
      items: [
        {
          responseType: "ladder",
          key: "family",
          revision: 2,
          variable: "ses_family",
          legacyVariable: "SES_Family_4",
          stem: { text: "Where would your family be on this ladder?" },
          lede: { text: societyLadderText },
          rungs: 10,
          lowestValue: 1,
          topLabel: "The people who are best off",
          bottomLabel: "The people who are worst off",
        },
        {
          responseType: "ladder",
          key: "self",
          revision: 2,
          variable: "ses_self",
          legacyVariable: "SES_Self_4",
          stem: { text: "Where would you be on this ladder?" },
          lede: { text: schoolLadderText },
          rungs: 10,
          lowestValue: 1,
          topLabel: "The people with the highest standing",
          bottomLabel: "The people with the lowest standing",
        },
      ],
    },
    {
      language: "en-GB",
      variant: "ybm-asadmin",
      label: "As administered: continuous 0-10 sliders (A-20; legacy values may be non-integer)",
      items: [
        {
          responseType: "slider",
          key: "family",
          revision: 1,
          variable: "ses_family",
          legacyVariable: "SES_Family_4",
          stem: { text: "Where would your family be on this ladder?" },
          lede: { text: societyLadderTextV1 },
          min: 0,
          max: 10,
        },
        {
          responseType: "slider",
          key: "self",
          revision: 1,
          variable: "ses_self",
          legacyVariable: "SES_Self_4",
          stem: { text: "Where would you be on this ladder?" },
          lede: { text: schoolLadderTextV1 },
          min: 0,
          max: 10,
        },
      ],
    },
  ],
  timeEstimates: est([90, 70]),
  changelog:
    "1.0: encoded from QSF. Canonical form uses discrete 10-rung ladders per D-08; administered continuous 0-10 sliders (Qualtrics JS ladder background) preserved as ybm-asadmin. " +
    "2.0 (D-23): the two click-through pages before each ladder are gone — the explanation now sits with the ladder on one screen as a lede, and 'imagine that the ladder below…' is rewritten for how it is actually presented. Response codes and anchors unchanged. " +
    "Revision 2 of both ladders (2026-10-18): the research team's rewording of both explanations and the school ladder's rung labels; codes unchanged.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// MacArthur Scale of Subjective Social Status – adult
// ---------------------------------------------------------------------------

// The adult form, for the social media break study (not the schools survey):
// a society ladder and a community ladder, in the wording the study supplied.
const placeYourself = "Where would you place yourself on this ladder at this time in your life?";

export const macarthurSssAdult: InstrumentInput = {
  instrument: "macarthur_sss_adult",
  version: "1.0",
  name: "MacArthur Scale of Subjective Social Status – Adult Version",
  abbreviation: "MacArthur SSS (adult)",
  construct: "Subjective social status (in society; in one's community)",
  citation:
    "Adler, N. E., Epel, E. S., Castellazzo, G., & Ickovics, J. R. (2000). Relationship of subjective and objective social status with psychological and physiological functioning: preliminary data in healthy white women. Health Psychology, 19(6), 586–592.",
  ageRange: { min: 18, max: 120 },
  licence: {
    status: "open",
    holder: "SPARQ / MacArthur Network toolkit, with attribution",
    modifiable: "yes",
    evidence: "Openly available and free to use for non-commercial research and clinical purposes (SPARQ toolkit); confirmed by the research team 2026-10-14 (D-61).",
    verified: true,
  },
  forms: [
    {
      language: "en-GB",
      label: "Adult society and community ladders (10 rungs, 1 at the bottom)",
      items: [
        {
          responseType: "ladder",
          key: "society",
          revision: 1,
          variable: "sss_society",
          stem: { text: "Where would you be on this ladder?" },
          lede: {
            text:
              "Think of this ladder as representing where people stand in society in the UK.\n\n" +
              "At the top are the people who are best off — those who have the most money, the most education, and the most respected jobs.\n\n" +
              "At the bottom are the people who are worst off — those who have the least money, the least education, and the least respected jobs, or no job.\n\n" +
              placeYourself,
          },
          rungs: 10,
          lowestValue: 1,
          topLabel: "The people who are best off",
          bottomLabel: "The people who are worst off",
        },
        {
          responseType: "ladder",
          key: "community",
          revision: 1,
          variable: "sss_community",
          stem: { text: "Where would you be on this ladder?" },
          lede: {
            text:
              "Think of this ladder as representing where people stand in their communities.\n\n" +
              "People define community in different ways. Please think about the community that is most meaningful to you.\n\n" +
              "At the top of the ladder are the people who have the highest standing in their community. At the bottom are the people who have the lowest standing.\n\n" +
              placeYourself,
          },
          rungs: 10,
          lowestValue: 1,
          topLabel: "The people with the highest standing",
          bottomLabel: "The people with the lowest standing",
        },
      ],
    },
  ],
  timeEstimates: est([60, 45]),
  changelog: "1.0: the adult society and community ladders in the social media break study's wording; recorded 1–10, 1 at the bottom.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// PHQ-4
// ---------------------------------------------------------------------------

const phq4Items: [string, string][] = [
  ["nervous", "Feeling nervous, anxious or on edge"],
  ["worrying", "Not being able to stop or control worrying"],
  ["interest", "Little interest or pleasure in doing things"],
  ["down", "Feeling down, depressed, or hopeless"],
];

export const phq4: InstrumentInput = {
  instrument: "phq4",
  version: "1.0",
  name: "Patient Health Questionnaire-4",
  abbreviation: "PHQ-4",
  construct: "Anxiety and depression (last 2 weeks): GAD-2 and PHQ-2",
  citation:
    "Kroenke, K., Spitzer, R. L., Williams, J. B. W., & Löwe, B. (2009). An ultra-brief screening scale for anxiety and depression: the PHQ-4. Psychosomatics, 50(6), 613–621. https://doi.org/10.1176/appi.psy.2009.50.6.613",
  ageRange: { min: 18, max: 120 },
  licence: {
    status: "open",
    holder: "Pfizer (PHQ screeners): free to use, no permission required",
    modifiable: "no",
    evidence: "The PHQ screeners are free to reproduce and use; added at the social media break study's request (2026-10-20).",
    verified: true,
  },
  forms: [
    {
      language: "en-GB",
      label: "PHQ-4 (en-GB) — the published items and anchors, coded 0–3",
      instructions: "Over the last two weeks, how often have you been bothered by the following problems?",
      items: phq4Items.map(([key, text], i) => row(key, `phq4_q${i + 1}`, "", text, "scale.phq_4pt")),
    },
  ],
  scoringKey: "score.phq4",
  timeEstimates: est([45, 30]),
  changelog: "1.0: Kroenke et al. (2009), items 1–2 anxiety (GAD-2), 3–4 depression (PHQ-2), each 0–3.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// SWEMWBS
// ---------------------------------------------------------------------------

const swemwbsItems: [string, string][] = [
  ["optimistic", "I’ve been feeling optimistic about the future"],
  ["useful", "I’ve been feeling useful"],
  ["relaxed", "I’ve been feeling relaxed"],
  ["problems", "I’ve been dealing with problems well"],
  ["thinking", "I’ve been thinking clearly"],
  ["close", "I’ve been feeling close to other people"],
  ["mind", "I’ve been able to make up my own mind about things"],
];

export const swemwbs: InstrumentInput = {
  instrument: "swemwbs",
  version: "1.0",
  name: "Short Warwick–Edinburgh Mental Wellbeing Scale",
  abbreviation: "SWEMWBS",
  construct: "Mental wellbeing (last 2 weeks)",
  citation:
    "Stewart-Brown, S., et al. (2009). Internal construct validity of the Warwick-Edinburgh Mental Well-being Scale (WEMWBS): a Rasch analysis using data from the Scottish Health Education Population Survey. Health and Quality of Life Outcomes, 7, 15.",
  ageRange: { min: 11, max: 120 },
  licence: held("University of Warwick, registered", "no"),
  forms: [
    {
      language: "en-GB",
      label: "SWEMWBS (en-GB) — administered form matches canonical",
      instructions:
        "The next few screens each show a statement about feelings and thoughts. For each one, choose the answer that best describes your experience over the last 2 weeks.",
      items: swemwbsItems.map(([key, text], i) =>
        row(key, `swemwbs_q${i + 1}`, `Mental well-being_${i + 1}`, text, "scale.swemwbs_5pt"),
      ),
    },
  ],
  scoringKey: "score.swemwbs",
  timeEstimates: est([120, 90]),
  changelog: "1.0: encoded from QSF; wording matches the canonical SWEMWBS. Metric-conversion scoring to be added with the scoring package.",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// SDQ 25 (self-report)
// ---------------------------------------------------------------------------

/**
 * The SDQ self-report for 11–17 year olds (S11-17) as youthinmind publishes it
 * (English, UK; © Robert Goodman, 2005), word for word.
 */
const sdqStems: string[] = [
  "I try to be nice to other people. I care about their feelings",
  "I am restless, I cannot stay still for long",
  "I get a lot of headaches, stomach-aches or sickness",
  "I usually share with others (food, games, pens etc.)",
  "I get very angry and often lose my temper",
  "I am usually on my own. I generally play alone or keep to myself",
  "I usually do as I am told",
  "I worry a lot",
  "I am helpful if someone is hurt, upset or feeling ill",
  "I am constantly fidgeting or squirming",
  "I have one good friend or more",
  "I fight a lot. I can make other people do what I want",
  "I am often unhappy, down-hearted or tearful",
  "Other people my age generally like me",
  "I am easily distracted, I find it difficult to concentrate",
  "I am nervous in new situations. I easily lose confidence",
  "I am kind to younger children",
  "I am often accused of lying or cheating",
  "Other children or young people pick on me or bully me",
  "I often volunteer to help others (parents, teachers, children)",
  "I think before I do things",
  "I take things that are not mine from home, school or elsewhere",
  "I get on better with adults than with people my own age",
  "I have many fears, I am easily scared",
  "I finish the work I'm doing. My attention is good",
];

/**
 * What YBM's Qualtrics survey and MySelf r1.0.0–r7.3.0 administered instead
 * (A-7): these three items in the wording of the 18+ form. Revision 1 of each;
 * the S11-17 wording above is revision 2 (D-51).
 */
const sdqAdministered: Record<number, string> = {
  19: "Other people pick on me or bully me",
  20: "I often offer to help others (family members, friends, colleagues)",
  22: "I take things that are not mine from home, work or elsewhere",
};

/** Item 22 of the 18+ form as this study words it (D-52); see sdq18Stems. */
const SDQ18_ITEM_22 = "I take things that are not mine from home, school or college, university, work or elsewhere";

/**
 * The SDQ self-report for those aged 18 and over (S18+) as youthinmind
 * publishes it (English, UK; © Robert Goodman, 2009), word for word except
 * item 22, which this study adapts for participants still in education (D-52).
 */
const sdq18Stems: string[] = [
  "I try to be nice to other people. I care about their feelings",
  "I am restless, I find it hard to sit down for long",
  "I get a lot of headaches, stomach-aches or sickness",
  "I usually share with others, for example food or drink",
  "I get very angry and often lose my temper",
  "I would rather be alone than with other people",
  "I am generally willing to do what other people want",
  "I worry a lot",
  "I am helpful if someone is hurt, upset or feeling ill",
  "I am constantly fidgeting or squirming",
  "I have at least one good friend",
  "I fight a lot. I can make other people do what I want",
  "I am often unhappy, depressed or tearful",
  "Other people generally like me",
  "I am easily distracted, I find it difficult to concentrate",
  "I am nervous in new situations. I easily lose confidence",
  "I am kind to children",
  "I am often accused of lying or cheating",
  "Other people pick on me or bully me",
  "I often offer to help others (family members, friends, colleagues)",
  "I think before I do things",
  // Adapted (D-52): the S18+ reads "…from home, work or elsewhere". Many of the
  // study's 18-year-olds are still at school or college, or at university.
  SDQ18_ITEM_22,
  "I get along better with older people than with people of my own age",
  "I have many fears, I am easily scared",
  "I finish the work I'm doing. My attention is good",
];

const sdqIntro =
  "For each statement, choose Not True, Somewhat True or Certainly True. It would help us if you answered them all as best you can, even if you are not absolutely certain. Answer on the basis of how things have been for you over the last six months.";

const sdqSubscales = [
  { key: "emotional", name: "Emotional symptoms", itemKeys: ["q3", "q8", "q13", "q16", "q24"] },
  { key: "conduct", name: "Conduct problems", itemKeys: ["q5", "q7", "q12", "q18", "q22"] },
  { key: "hyperactivity", name: "Hyperactivity/inattention", itemKeys: ["q2", "q10", "q15", "q21", "q25"] },
  { key: "peer", name: "Peer relationship problems", itemKeys: ["q6", "q11", "q14", "q19", "q23"] },
  { key: "prosocial", name: "Prosocial behaviour", itemKeys: ["q1", "q4", "q9", "q17", "q20"] },
];

const sdqForm = (variant: string | undefined, label: string, scale: string, asAdministered: boolean) => ({
  language: "en-GB" as const,
  ...(variant ? { variant } : {}),
  label,
  instructions: sdqIntro,
  items: sdqStems.map((text, i) => {
    const n = i + 1;
    const administered = sdqAdministered[n];
    const item = row(`q${n}`, `sdq25_q${n}`, `sdq_${n}`, administered && asAdministered ? administered : text, scale, {
      required: "soft",
      allowDecline: true, // D-05: administered ForceResponse contradicted instructions (A-44)
    });
    if (!administered) return item;
    return asAdministered
      ? { ...item, researcherNote: "The 18+ form's wording, as administered up to r7.3.0 (A-7); the S11-17 wording is revision 2 (D-51)." }
      : {
          ...item,
          revision: 2,
          researcherNote: `Revision 2 (D-51): the S11-17 wording. Revision 1, administered in r1.0.0–r7.3.0, was the 18+ form's "${administered}" (A-7).`,
        };
  }),
});

export const sdq25S: InstrumentInput = {
  instrument: "sdq25_s",
  version: "2.0",
  name: "Strengths and Difficulties Questionnaire (self-report)",
  abbreviation: "SDQ",
  construct: "Emotional and behavioural difficulties; prosocial behaviour (last 6 months)",
  citation:
    "Goodman, R. (1997). The Strengths and Difficulties Questionnaire: a research note. Journal of Child Psychology and Psychiatry, 38(5), 581-586.",
  ageRange: { min: 11, max: 17 },
  licence: held("youthinmind, authorised for electronic administration", "no"),
  forms: [
    sdqForm(undefined, "SDQ self-report 11–17 (S11-17), canonical anchors ('Certainly True', coded 0-2) per D-08", "scale.sdq_3pt", false),
    sdqForm("ybm-asadmin", "SDQ as administered, YBM 2026 ('Clearly true' anchor — A-6)", "scale.sdq_3pt_ybm", true),
  ],
  subscales: sdqSubscales,
  reverseScoredItems: ["q7", "q11", "q14", "q21", "q25"],
  scoringKey: "score.sdq25_s",
  timeEstimates: est([300, 240]),
  changelog:
    "1.0: encoded from QSF. Canonical form restores 'Certainly True' and 0-2 coding per D-08; items 20/22 flagged for edition verification (A-7). Administered form preserved as ybm-asadmin. Soft-required with decline per D-05. " +
    "2.0 (D-51): the canonical form is the S11-17 word for word — items 19, 20 and 22 move from the 18+ form's wording to the S11-17's (revision 2); participants 18 and over are given sdq25_s18 instead. The administered form is unchanged.",
  owner: "ybm",
  researcherNotes:
    "youthinmind licence attested held (D-10). Subscale/reverse-item allocations follow published SDQ scoring; verify against youthinmind scoring sheet before approval.",
};

export const sdq25S18: InstrumentInput = {
  instrument: "sdq25_s18",
  version: "1.0",
  name: "Strengths and Difficulties Questionnaire (self-report, 18+)",
  abbreviation: "SDQ 18+",
  construct: "Emotional and behavioural difficulties; prosocial behaviour (last 6 months)",
  citation:
    "Goodman, R. (1997). The Strengths and Difficulties Questionnaire: a research note. Journal of Child Psychology and Psychiatry, 38(5), 581-586. Form: youthinmind SDQ self-report for those aged 18 and over (S18+, © Robert Goodman, 2009).",
  ageRange: { min: 18, max: 120 },
  licence: {
    status: "permission_held",
    holder: "youthinmind, authorised for electronic administration",
    modifiable: "no",
    evidence:
      "The research team's SDQ permission (D-10). That it covers the S18+ form is to be confirmed with youthinmind (D-51).",
    verified: false,
  },
  forms: [
    {
      language: "en-GB",
      label: "SDQ self-report 18+ (S18+), canonical anchors ('Certainly True', coded 0-2); item 22 adapted (D-52)",
      instructions: sdqIntro,
      items: sdq18Stems.map((text, i) => {
        const n = i + 1;
        const { legacyVariable: _none, ...item } = row(`q${n}`, `sdq25_s18_q${n}`, "", text, "scale.sdq_3pt", {
          required: "soft",
          allowDecline: true, // as the S11-17 (D-05)
        });
        return n === 22
          ? {
              ...item,
              researcherNote:
                "Adapted by the study (D-52): the published S18+ reads 'I take things that are not mine from home, work or elsewhere'. 'school or college, university' added because many participants of 18 are still in education. youthinmind's terms do not allow changes without their permission.",
            }
          : item;
      }),
    },
  ],
  subscales: sdqSubscales,
  reverseScoredItems: ["q7", "q11", "q14", "q21", "q25"],
  scoringKey: "score.sdq25_s18",
  timeEstimates: [
    { ageBand: "17-18", medianSeconds: 240, provenance: "estimated-heuristic" },
    { ageBand: "adult", medianSeconds: 220, provenance: "estimated-heuristic" },
  ],
  changelog:
    "1.0 (D-51, D-52): the S18+ word for word, for participants aged 18 or over on the day the sitting started, except item 22, adapted to name school or college and university as well as work.",
  owner: "ybm",
  researcherNotes:
    "Scored exactly as the S11-17: youthinmind's scoring instructions are 'identical for the similarly-worded 18+ SDQ' (Scoring the SDQ for age 4-17 or 18+, 20 June 2016). The 4–17 cut-points 'have not been validated for use with the 18+ SDQ': report continuous scores.",
};

// ---------------------------------------------------------------------------
// RCADS-25
// ---------------------------------------------------------------------------

const rcadsStems: string[] = [
  "I feel sad or empty.",
  "I worry when I think I have done poorly at something.",
  "I would feel afraid of being on my own at home.",
  "Nothing is much fun anymore.",
  "I worry that something awful will happen to someone in my family.",
  "I am afraid of being in crowded places (like shopping centres, the movies, buses, busy playgrounds)",
  "I worry what other people think of me.",
  "I have trouble sleeping.",
  "I feel scared if I have to sleep on my own.",
  "I have problems with my appetite.",
  "I suddenly become dizzy or faint when there is no reason for this.",
  "I have to do some things over and over again (like washing my hands, cleaning or putting things in a certain order).",
  "I have no energy for things.",
  "I suddenly start to tremble or shake when there is no reason for this.",
  "I cannot think clearly.",
  "I feel worthless.",
  "I have to think of special thoughts (like numbers or words) to stop bad things from happening.",
  "I think about death.",
  "I feel like I don’t want to move.",
  "I worry that I will suddenly get a scared feeling when there is nothing to be afraid of.",
  "I am tired a lot.",
  "I feel afraid that I will make a fool of myself in front of people.",
  "I have to do some things in just the right way to stop bad things from happening.",
  "I feel restless.",
  "I worry that something bad will happen to me.",
];

export const rcads25: InstrumentInput = {
  instrument: "rcads25",
  version: "1.0",
  name: "Revised Child Anxiety and Depression Scale – 25",
  abbreviation: "RCADS-25",
  construct: "Anxiety (15 items) and depression (10 items) symptoms",
  citation:
    "Ebesutani, C., Reise, S. P., Chorpita, B. F., Ale, C., Regan, J., Young, J., Higa-McMillan, C., & Weisz, J. R. (2012). The Revised Child Anxiety and Depression Scale - Short Version. Psychological Assessment, 24(4), 833-845.",
  ageRange: { min: 8, max: 18 },
  licence: held("rcads.ucla.edu, permission granted", "no"),
  forms: [
    {
      language: "en-GB",
      label: "RCADS-25 (en-GB) — administered wording matches canonical; canonical 0-3 coding",
      instructions:
        "The next questions are about your feelings and mental health. Some of them may be difficult to answer. Your answers are private (your name is kept apart from them), and if you don't want to answer a question, you can skip it. If any of these questions upset you, let a member of the research team know. Please choose how often each of these things happens to you.",
      items: rcadsStems.map((text, i) => {
        const n = i + 1;
        const item = row(`q${n}`, `rcads25_q${n}`, `rcads_${n}`, text, "scale.rcads_4pt", {
          required: "soft",
          allowDecline: true, // D-05: honour the skip promise (A-44)
        });
        // q17 restored to the canonical wording; it had lost "of", "from" and
        // the plural of "numbers" (QC 2026-10-17).
        if (n === 17) return { ...item, revision: 2 };
        if (n === 18) {
          return {
            ...item,
            researcherNote:
              "Safeguarding-relevant item (A-29). Flag mechanism available; no automated rules configured (D-11: researcher review only).",
          };
        }
        return item;
      }),
    },
  ],
  subscales: [
    {
      key: "depression",
      name: "Total depression (10 items)",
      itemKeys: ["q1", "q4", "q8", "q10", "q13", "q15", "q16", "q18", "q19", "q21"],
    },
    {
      key: "anxiety",
      name: "Total anxiety (15 items)",
      itemKeys: ["q2", "q3", "q5", "q6", "q7", "q9", "q11", "q12", "q14", "q17", "q20", "q22", "q23", "q24", "q25"],
    },
  ],
  scoringKey: "score.rcads25",
  timeEstimates: est([300, 240]),
  changelog: "1.0: encoded from QSF; canonical 0-3 coding with legacy 1-4 crosswalk (A-16). Soft-required with decline per D-05.",
  owner: "ybm",
  researcherNotes: "Subscale allocation to be verified against Ebesutani et al. (2012) before approval; T-score norms added with the scoring package.",
};

// ---------------------------------------------------------------------------
// STAI-5 (state short form)
// ---------------------------------------------------------------------------

const staiStems: [string, string][] = [
  ["upset", "I feel upset."],
  ["frightened", "I feel frightened."],
  ["nervous", "I feel nervous."],
  ["jittery", "I am jittery."],
  ["confused", "I feel confused."],
];

export const stai5S: InstrumentInput = {
  instrument: "stai5_s",
  version: "1.0",
  name: "STAI-5 (state anxiety short form)",
  abbreviation: "STAI-5",
  construct: "State anxiety (right now)",
  citation:
    "Zsido, A. N., Teleki, S. A., Csokasi, K., Rozsa, S., & Bandi, S. A. (2020). Development of the short version of the Spielberger State-Trait Anxiety Inventory. Psychiatry Research, 291, 113223.",
  ageRange: { min: 11, max: 120 },
  licence: held("Mind Garden, Zsido short form, licensed", "no"),
  forms: [
    {
      language: "en-GB",
      label: "STAI-5 state (en-GB)",
      instructions:
        "The next few screens each show a statement people have used to describe themselves. Read the statement and choose the answer that indicates how you feel right now, that is, at this moment. There are no right or wrong answers. Do not spend too much time on any one statement — give the answer that seems to describe your present feelings best.",
      items: staiStems.map(([key, text], i) => row(key, `stai5_q${i + 1}`, `STAI-S_${i + 1}`, text, "scale.stai_4pt")),
    },
  ],
  scoringKey: "score.stai5",
  timeEstimates: est([80, 60]),
  changelog: "1.0: encoded from QSF; matches Zsido et al. (2020) item set. Note: STAI-T 5-item block existed in the Qualtrics Trash (removed pre-launch).",
  owner: "ybm",
};

// ---------------------------------------------------------------------------
// BIS/BAS 12-item YBM subset
// ---------------------------------------------------------------------------

const bisbasRows: [string, string, number, string][] = [
  // [key, stem, legacy row code, subscale]
  ["bis1", "I worry about making mistakes", 1, "bis"],
  ["bis2", "Criticism or scolding hurts me quite a bit", 2, "bis"],
  ["bis3", "I feel pretty worried or upset when I think or know somebody is angry at me", 3, "bis"],
  ["bis4", "I feel worried when I think I have done poorly at something important", 4, "bis"], // stray quote removed (D-07)
  ["rr1", "When I get something I want, I feel excited and energised", 5, "reward"],
  ["rr2", "When I'm doing well at something I love to keep at it", 6, "reward"],
  ["rr3", "It would excite me to win a contest", 7, "reward"],
  ["rr4", "When I see an opportunity for something I like I get excited right away", 8, "reward"],
  ["dr1", "When I want something I usually go all-out to get it", 25, "drive"],
  ["dr2", "I go out of my way to get things I want", 9, "drive"],
  ["dr3", "If I see a chance to get something I want I move on it right away", 26, "drive"],
  ["dr4", "When I go after something I use a no holds barred approach", 27, "drive"],
];

export const bisbas12Ybm: InstrumentInput = {
  instrument: "bisbas12_ybm",
  version: "1.0",
  name: "BIS/BAS – 12-item YBM subset",
  abbreviation: "BIS/BAS-12 (YBM)",
  construct: "Behavioural inhibition (4), BAS reward responsiveness (4), BAS drive (4); Fun Seeking omitted",
  citation:
    "Carver, C. S., & White, T. L. (1994). Behavioral inhibition, behavioral activation, and affective responses to impending reward and punishment: The BIS/BAS Scales. Journal of Personality and Social Psychology, 67(2), 319-333. (Administered as an explicit 12-item subset — A-22.)",
  ageRange: { min: 11, max: 120 },
  licence: held("Carver & White scale, licensed for research use", "with_permission"),
  forms: [
    {
      language: "en-GB",
      label: "BIS/BAS 12-item subset as administered in YBM 2026",
      instructions:
        "Each of the next screens shows a statement that a person may either agree with or disagree with. For each one, say how much you agree or disagree. Please answer them all. Be as accurate and honest as you can, and treat each statement on its own — don't worry about being \"consistent\" across them.",
      items: bisbasRows.map(([key, text, legacyRow]) =>
        row(key, `bisbas12_${key}`, `bisbas_${legacyRow}`, text, "scale.bisbas_4pt"),
      ),
    },
  ],
  subscales: [
    { key: "bis", name: "Behavioural inhibition (subset)", itemKeys: ["bis1", "bis2", "bis3", "bis4"] },
    { key: "reward", name: "BAS reward responsiveness", itemKeys: ["rr1", "rr2", "rr3", "rr4"] },
    { key: "drive", name: "BAS drive", itemKeys: ["dr1", "dr2", "dr3", "dr4"] },
  ],
  scoringKey: "score.bisbas12_ybm",
  timeEstimates: est([180, 140]),
  changelog:
    "1.0: encoded from QSF. This IS the as-administered form (an undocumented subset — there is no separate canonical 12-item edition). Legacy matrix row codes 1-8,25,9,26,27 preserved via legacyVariable. Stray quote in bis4 removed per D-07.",
  owner: "ybm",
  researcherNotes: "Subset provenance (possibly the AoW source study) to document; reverse-scoring rules per Carver & White added with the scoring package.",
};

// ---------------------------------------------------------------------------
// Doomscrolling items (4)
// ---------------------------------------------------------------------------

const doomStems: string[] = [
  "I feel an urge to seek bad news on social media, more and more often.",
  "I lose track of time when I read bad news on social media.",
  "I find myself continuously browsing negative news.",
  "I feel like I am addicted to negative news.",
];

export const doomscroll4: InstrumentInput = {
  instrument: "doomscroll4",
  version: "1.0",
  name: "Doomscrolling items (4)",
  abbreviation: "DS-4",
  construct: "Compulsive negative-news consumption",
  citation: "Possibly derived from Sharma, B., Lee, S. S., & Johnson, B. K. (2022), Technology, Mind, and Behavior — source verification outstanding (A-23).",
  citationVerified: false,
  ageRange: { min: 11, max: 120 },
  licence: held("Source scale authors, permission granted", "no"),
  forms: [
    {
      language: "en-GB",
      label: "Doomscrolling 4-item set as administered (7-point, disagree-first — A-18)",
      instructions: "The next few screens each show a statement. For each one, say how much you agree.",
      items: doomStems.map((text, i) => row(`q${i + 1}`, `doomscroll_q${i + 1}`, `Doomscrolling _${i + 1}`, text, "scale.doomscroll_7pt")),
    },
  ],
  timeEstimates: est([70, 55]),
  changelog: "1.0: encoded from QSF. Note the legacy export tag carries a trailing space ('Doomscrolling _N').",
  owner: "ybm",
};

export const allInstruments: InstrumentInput[] = attachProvenance([
  kss,
  sqs,
  ehiSf,
  macarthurSsy,
  macarthurSssAdult,
  phq4,
  swemwbs,
  sdq25S,
  sdq25S18,
  rcads25,
  stai5S,
  bisbas12Ybm,
  doomscroll4,
]);
