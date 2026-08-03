import type { z } from "zod";
import type { instrumentVersion, itemDefinition, licence, timeEstimate } from "@myself/schema";

/**
 * Validated instruments of the YBM library, encoded from the QSF
 * (source-materials/qsf_questions.json) with decisions D-01..D-15 applied.
 * Records are authored as z.input shapes; the test suite parses them against
 * the schemas, applying defaults and enforcing all invariants.
 *
 * Licence status: permission_held on researcher attestation (D-10,
 * 2026-08-02); `verified` remains false until documents are filed.
 */

export type InstrumentInput = z.input<typeof instrumentVersion>;
type ItemInput = z.input<typeof itemDefinition>;
type LicenceInput = z.input<typeof licence>;
type TimeEstimateInput = z.input<typeof timeEstimate>;

const attested = (holder: string, modifiable: LicenceInput["modifiable"]): LicenceInput => ({
  status: "permission_held",
  holder,
  modifiable,
  evidence: "Researcher attestation in-session 2026-08-02 (D-10); documentation to be filed in the licence register.",
  verified: false,
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
    legacyVariable,
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
  licence: attested("Public academic use (to document)", "no"),
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
  changelog: "1.0: encoded from YBM NotreDame2026 QSF; canonical labels restored per D-08.",
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
      // Report what the answers say about this person, and stop. An earlier
      // draft added "being in the middle is genuinely uncommon, not a mistake"
      // — which tells someone their result needs excusing, and is a judgement
      // nobody asked for (D-34).
      stem: {
        text: "Your answers suggest you're {band}",
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
  licence: attested("Open research use (to document)", "no"),
  forms: [
    ehiForm(
      undefined,
      "EHI-SF canonical (Veale 2014 anchors, confirmed by the researcher 2026-08-02)",
      "scale.ehi_sf_5pt",
      "Please indicate your preferences in the use of hands in the following activities.",
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
const societyLadderText =
  "This ladder stands for where people sit in British society. At the top are the people who are best off — the most money, the most schooling, and the jobs that bring the most respect. At the bottom are the people who are worst off — the least money, little or no education, no job, or jobs nobody wants.";
const schoolLadderText =
  "This ladder stands for where people sit in your school. At the top are the people with the most respect, the highest grades and the highest standing. At the bottom are the people nobody respects, nobody wants to be around, and who have the worst grades.";

export const macarthurSsy: InstrumentInput = {
  instrument: "macarthur_ssy",
  version: "1.0",
  name: "MacArthur Scale of Subjective Social Status – Youth Version",
  abbreviation: "MacArthur SSS-Y",
  construct: "Subjective social status (family in society; self in school)",
  citation:
    "Goodman, E., Adler, N. E., Kawachi, I., Frazier, A. L., Huang, B., & Colditz, G. A. (2001). Adolescents' perceptions of social status: development and evaluation of a new indicator. Pediatrics, 108(2), e31.",
  ageRange: { min: 10, max: 18 },
  licence: attested("SPARQ / MacArthur Network toolkit (attribution to confirm)", "no"),
  forms: [
    {
      language: "en-GB",
      label: "Canonical discrete 10-rung ladders (D-08)",
      items: [
        {
          responseType: "ladder",
          key: "family",
          revision: 1,
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
          revision: 1,
          variable: "ses_self",
          legacyVariable: "SES_Self_4",
          stem: { text: "Where would you be on this ladder?" },
          lede: { text: schoolLadderText },
          rungs: 10,
          lowestValue: 1,
          topLabel: "The people with the most respect and highest standing",
          bottomLabel: "The people with the least respect and lowest standing",
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
          lede: { text: societyLadderText },
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
          lede: { text: schoolLadderText },
          min: 0,
          max: 10,
        },
      ],
    },
  ],
  timeEstimates: est([90, 70]),
  changelog:
    "1.0: encoded from QSF. Canonical form uses discrete 10-rung ladders per D-08; administered continuous 0-10 sliders (Qualtrics JS ladder background) preserved as ybm-asadmin. " +
    "2.0 (D-23): the two click-through pages before each ladder are gone — the explanation now sits with the ladder on one screen as a lede, and 'imagine that the ladder below…' is rewritten for how it is actually presented. Response codes and anchors unchanged.",
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
  licence: attested("University of Warwick (registration attested held)", "no"),
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
  "Other people pick on me or bully me",
  "I often offer to help others (family members, friends, colleagues)",
  "I think before I do things",
  "I take things that are not mine from home, work or elsewhere",
  "I get on better with adults than with people my own age",
  "I have many fears, I am easily scared",
  "I finish the work I'm doing. My attention is good",
];

const sdqIntro =
  "For each statement, choose Not True, Somewhat True or Certainly True. It would help us if you answered them all as best you can, even if you are not absolutely certain. Answer on the basis of how things have been for you over the last six months.";

const sdqForm = (variant: string | undefined, label: string, scale: string) => ({
  language: "en-GB" as const,
  ...(variant ? { variant } : {}),
  label,
  instructions: sdqIntro,
  items: sdqStems.map((text, i) => {
    const n = i + 1;
    const item = row(`q${n}`, `sdq25_q${n}`, `sdq_${n}`, text, scale, {
      required: "soft",
      allowDecline: true, // D-05: administered ForceResponse contradicted instructions (A-44)
    });
    if (n === 20 || n === 22) {
      return {
        ...item,
        researcherNote:
          "Wording matches the SDQ 18+ self-report phrasing; verify against youthinmind S11-17 before approving the canonical form (A-7).",
      };
    }
    return item;
  }),
});

export const sdq25S: InstrumentInput = {
  instrument: "sdq25_s",
  version: "1.0",
  name: "Strengths and Difficulties Questionnaire (self-report)",
  abbreviation: "SDQ",
  construct: "Emotional and behavioural difficulties; prosocial behaviour (last 6 months)",
  citation:
    "Goodman, R. (1997). The Strengths and Difficulties Questionnaire: a research note. Journal of Child Psychology and Psychiatry, 38(5), 581-586.",
  ageRange: { min: 11, max: 17 },
  licence: attested("youthinmind (electronic-administration authorisation attested held)", "no"),
  forms: [
    sdqForm(undefined, "SDQ self-report, canonical anchors ('Certainly True', coded 0-2) per D-08", "scale.sdq_3pt"),
    sdqForm("ybm-asadmin", "SDQ as administered, YBM 2026 ('Clearly true' anchor — A-6)", "scale.sdq_3pt_ybm"),
  ],
  subscales: [
    { key: "emotional", name: "Emotional symptoms", itemKeys: ["q3", "q8", "q13", "q16", "q24"] },
    { key: "conduct", name: "Conduct problems", itemKeys: ["q5", "q7", "q12", "q18", "q22"] },
    { key: "hyperactivity", name: "Hyperactivity/inattention", itemKeys: ["q2", "q10", "q15", "q21", "q25"] },
    { key: "peer", name: "Peer relationship problems", itemKeys: ["q6", "q11", "q14", "q19", "q23"] },
    { key: "prosocial", name: "Prosocial behaviour", itemKeys: ["q1", "q4", "q9", "q17", "q20"] },
  ],
  reverseScoredItems: ["q7", "q11", "q14", "q21", "q25"],
  scoringKey: "score.sdq25_s",
  timeEstimates: est([300, 240]),
  changelog:
    "1.0: encoded from QSF. Canonical form restores 'Certainly True' and 0-2 coding per D-08; items 20/22 flagged for edition verification (A-7). Administered form preserved as ybm-asadmin. Soft-required with decline per D-05.",
  owner: "ybm",
  researcherNotes:
    "youthinmind licence attested held (D-10). Subscale/reverse-item allocations follow published SDQ scoring; verify against youthinmind scoring sheet before approval.",
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
  "I have to think special thoughts (like number or words) to stop bad things happening.",
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
  licence: attested("rcads.ucla.edu permission process (attested held)", "no"),
  forms: [
    {
      language: "en-GB",
      label: "RCADS-25 (en-GB) — administered wording matches canonical; canonical 0-3 coding",
      instructions:
        "The next questions are about your feelings and mental health. Some of these questions may be difficult to answer. Remember, all your answers are completely confidential and if you do not want to answer a question, you can skip it. Please select how often each of these things happen to you.",
      items: rcadsStems.map((text, i) => {
        const n = i + 1;
        const item = row(`q${n}`, `rcads25_q${n}`, `rcads_${n}`, text, "scale.rcads_4pt", {
          required: "soft",
          allowDecline: true, // D-05: honour the skip promise (A-44)
        });
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
  licence: attested("Mind Garden / Zsido short form (attested held)", "no"),
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
  licence: attested("Carver & White scale, research use (to document); subset provenance to record", "with_permission"),
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
  licence: attested("Source scale authors (attested held; verify scope)", "no"),
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

export const allInstruments: InstrumentInput[] = [
  kss,
  ehiSf,
  macarthurSsy,
  swemwbs,
  sdq25S,
  rcads25,
  stai5S,
  bisbas12Ybm,
  doomscroll4,
];
