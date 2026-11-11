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

const QSF = "The YBM 2026 Qualtrics survey (Yorkshire Brain Map 2026 QSF), encoded into the library in 2026.";
const QSF_UNKNOWN =
  "The survey file does not record who first wrote these questions, or whether any were taken from elsewhere. To confirm with the team that wrote the 2026 survey.";
const TEAM = "YBM research team";

const PEW_SURVEY =
  "Pew Research Center, 2025 Teens Survey (Teens & Technology): US teens aged 13-17, n = 1,458, online, 25 September to 9 October 2025.";
const PEW_TOPLINE_FEB =
  "'How Teens Use and View AI', 24 February 2026, https://www.pewresearch.org/wp-content/uploads/sites/20/2026/02/PI_2026.02.24_Teens-and-AI_TOPLINE.pdf";
const PEW_TOPLINE_DEC =
  "'Teens, Social Media and AI Chatbots 2025', 9 December 2025, https://www.pewresearch.org/wp-content/uploads/sites/20/2025/12/PI_2025.12.09_Teens-Social-Media-AI_TOPLINE.pdf";

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
      "A 12-item subset (BIS 4, Reward Responsiveness 4, Drive 4; Fun Seeking left out), as in the 2026 Qualtrics survey (A-22). Who chose the subset, and whether it was used before (possibly in Born in Bradford's Age of Wonder study), is not recorded.",
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
      "Age of Wonder (AoW), the Born in Bradford adolescent cohort study: the 2026 Qualtrics survey's social media block is titled 'adapted from AoW' (source confirmed by the principal investigator, 2026-10-21). What exactly the 2026 team adapted from the AoW questions is not recorded.",
    adaptations:
      "Per-platform time stepped into one question each, with the Twitch condition corrected (D-02); abstain-effect wording restored (D-01); family-control follow-ups written by the research team (D-53).",
    notes: "To add: a citation for the Age of Wonder questionnaire, and what the 2026 team changed from it. Using AoW's wording keeps these answers comparable with the Born in Bradford cohort.",
    decisions: ["D-01", "D-02", "D-53"],
  },
  ybm_ai_use: {
    kind: "researcher_developed",
    developedBy: TEAM,
    evidence: "None yet; there is no short validated measure of adolescents' AI use (D-59).",
    decisions: ["D-59"],
  },
  ybm_ai_views: {
    kind: "researcher_developed",
    developedBy: TEAM,
    involvement: [{ group: "YBM research team", role: "asked for questions on perceptions of AI", when: "2026-11" }],
    evidence: "None yet; study-written, like ybm_ai_use (D-59).",
    decisions: ["D-72"],
  },
  ybm_ai_chatbots: {
    kind: "existing_items",
    basedOn: `${PEW_SURVEY} Teen questions TCHATAWARE, TCHATUSE, TCHATFREQ, TCHATSPEC, TCHATWHY, TCHATFREQ2, TCHATHELPFUL, TCHATSCH1 and TCHATSCH2, as published in the toplines: ${PEW_TOPLINE_FEB} and ${PEW_TOPLINE_DEC}.`,
    adaptations:
      "Wording and answer options are Pew's, word for word, apart from: each grid (TCHATSPEC, TCHATWHY, TCHATSCH1) is one screen per row, asked as a question ('Do you ever use ChatGPT?', 'Have you ever used AI chatbots to …?') with Pew's answer labels, in a fixed order where Pew randomises; Pew rotates some answer orders, here always shown in Pew's listed order; British spelling ('summarise', 'maths'). Added: Snapchat's My AI as a seventh chatbot, and two study-written questions (ai_felt_friend, ai_why_not_person). Each question's own record gives its Pew ID, Pew's wording and Pew's result.",
    developedBy: TEAM,
    evidence:
      "Not a validated scale: single survey items from a national online survey of US teens. Benchmark: Pew's published results for US teens aged 13-17; compare this study's 13-17 year olds only, and allow for country, school setting (in class, on an iPad) and date.",
    decisions: ["D-88"],
    notes: "Chosen over study-written items so that answers can be compared with a published, regularly repeated source (PI's request, November 2026). UK figures to set alongside (no shared wording): Ofcom, Children and Parents: Media Use and Attitudes 2026 (56% of 8-17s have used AI); National Literacy Trust Annual Literacy Survey 2025 (66.5% of 13-18s use generative AI); Internet Matters, Me, Myself and AI, 2025 (64% of 9-17s use AI chatbots).",
  },
  ybm_ai_tools: {
    kind: "existing_items",
    basedOn: `${PEW_SURVEY} Teen question TCHATSPEC, as published in ${PEW_TOPLINE_DEC}.`,
    adaptations:
      "Pew's question wording and list of chatbots, in Pew's order, asked as one select-all list instead of a Yes/No row per chatbot (the PI's request, November 2026, to shorten it), with Snapchat's My AI and 'Something else' (named in a box) added.",
    developedBy: TEAM,
    evidence:
      "Benchmark with care: select-all lists tend to give lower percentages than a Yes/No question per item, so this study's figures may run below Pew's for the same population. Pew (US teens 13-17 who use AI chatbots): ChatGPT 92%, Gemini 36%, Meta AI 31%, Copilot 23%, Character.ai 14%, Claude 5%.",
    decisions: ["D-88", "D-93"],
  },
  ybm_ai_uses: {
    kind: "existing_items",
    basedOn: `${PEW_SURVEY} Teen question TCHATWHY, as published in ${PEW_TOPLINE_FEB}.`,
    adaptations:
      "Pew's question and its eight rows, in Pew's order, asked as one select-all list instead of a Yes/No row per use (the PI's request, November 2026), with 'Something else' (described in a box) added; British spelling ('Summarise').",
    developedBy: TEAM,
    evidence:
      "Benchmark with care: select-all lists tend to give lower percentages than a Yes/No question per item. Pew (US teens 13-17 who use AI chatbots): search for information 89%, help with schoolwork 85%, fun or entertainment 74%, summarise 65%, images or videos 59%, news 30%, casual conversation 25%, emotional support or advice 18%.",
    decisions: ["D-88", "D-94"],
  },
  ybm_ai_outlook: {
    kind: "existing_items",
    basedOn: `${PEW_SURVEY} Teen questions TAIIMP and TAIIMPSELF, with TAIHEARD's definition of AI, as published in ${PEW_TOPLINE_FEB}.`,
    adaptations:
      "Two of the five questions are Pew's, word for word, apart from British spelling ('recognising') and a fixed answer order where Pew rotates 1-5 or 5-1. The other three (worries, spotting AI-made content, adult guidance) are study-written; their own records say so.",
    developedBy: TEAM,
    evidence: "Not a validated scale. Benchmark for the two impact questions: Pew's published results for US teens aged 13-17.",
    decisions: ["D-88"],
  },
  ybm_online_life: {
    kind: "researcher_developed",
    developedBy: TEAM,
    involvement: [{ group: "YBM research team", role: "asked for questions on shopping apps and the planned under-16 ban", when: "2026-11" }],
    evidence:
      "None yet; study-written. Context: the UK government announced in June 2026 that it intends to stop under-16s using social media, and in November 2026 said it was considering adding selling and shopping apps such as Vinted and eBay.",
    decisions: ["D-89"],
  },
  ybm_under16_ban: {
    kind: "researcher_developed",
    developedBy: TEAM,
    basedOn: "The study's own questions for parents on the planned under-16 social media ban, as given by the PI (November 2026), reworded for the pupil.",
    evidence: "None yet; study-written. Asked in the same words as the parents' questions so that a pupil's answers can be compared with their parent's.",
    decisions: ["D-92"],
    notes: "To confirm: where the parents' versions are asked (and their exact middle answer labels), so the two can be matched in analysis.",
  },
  ybm_hearing: {
    kind: "existing_items",
    basedOn:
      "Two established self-report questions: NHANES (US National Health and Nutrition Examination Survey) audiometry questionnaire item AUQ054, 'General condition of hearing' (e.g. 2015-2016 cycle, https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2015/DataFiles/AUQ_I.htm), and UK Biobank touchscreen data-field 2257, 'Hearing difficulty with background noise'.",
    adaptations:
      "Wording as given by the PI (November 2026). AUQ054: NHANES is interviewer-administered, with a proxy answering for under-16s; here pupils read and answer it themselves, and option 4 reads 'Moderate trouble' for NHANES's 'Moderate hearing trouble'. Field 2257: UK Biobank's answers are Yes / No / Do not know / Prefer not to answer; here 'Yes' is split into 'Yes, all or most of the time' and 'Yes, sometimes', and 'Prefer not to answer' is left out (any question can be skipped).",
    developedBy: TEAM,
    evidence:
      "Single self-report items, widely used in adults (UK Biobank) and across ages (NHANES, by proxy under 16); not, as far as the record shows, validated as self-report in 11-18 year olds. Benchmarks: NHANES published distributions by age; UK Biobank (adults aged 40-69).",
    decisions: ["D-91"],
    notes: "Where the split of 'Yes' by frequency comes from is not recorded: to confirm with the PI.",
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

/**
 * One Pew Research Center teen question (D-88): its ID, Pew's exact wording,
 * what this survey changed, and Pew's published result for US teens.
 */
const pew = (id: string, wording: string, changes: string, result: string, topline: "feb" | "dec" = "feb"): ProvenanceInput => ({
  kind: "existing_items",
  basedOn: `${PEW_SURVEY} Question ${id}: “${wording}” Topline: ${topline === "feb" ? PEW_TOPLINE_FEB : PEW_TOPLINE_DEC}.`,
  adaptations: changes,
  developedBy: TEAM,
  evidence: `Pew result (US teens 13-17, ${topline === "feb" ? "topline of 24 February 2026" : "topline of 9 December 2025"}): ${result}`,
  decisions: ["D-88"],
});
const SAME = "None: Pew's wording and answer options, word for word.";
const ROW = (row: string) =>
  `Pew asks this as row '${row}' of a grid, in random order; here it is its own screen, asked as a question with Pew's answer labels, in a fixed order.`;
const WHY = "Have you ever used artificial intelligence (AI) chatbots for the following?";
const SPEC = "Which of the following artificial intelligence (AI) chatbots do you ever use?";
const SCH1 = "Have you ever used artificial intelligence (AI) chatbots to help with any of the following for school?";
const ofUsers = (n: number) => `${n}% of teens who use AI chatbots said yes.`;
const ofSchool = (n: number) => `${n}% of teens who use AI chatbots for schoolwork said yes.`;

export const QUESTION_PROVENANCE: Record<string, Record<string, ProvenanceInput>> = {
  ybm_hearing: {
    hearing: {
      kind: "existing_items",
      basedOn:
        "NHANES item AUQ054, 'General condition of hearing': “Which statement best describes your hearing (without a hearing aid or other listening devices)?” Answers Excellent / Good / A little trouble / Moderate hearing trouble / A lot of trouble / Deaf. https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2015/DataFiles/AUQ_I.htm",
      adaptations:
        "The read-out of the options is part of the question, as the PI gave it; option 4 'Moderate trouble' for 'Moderate hearing trouble'; self-completed on an iPad rather than asked by an interviewer (NHANES uses a proxy under 16). The 2021-2023 NHANES cycle adds 'personal sound amplifier' to the bracket; this follows the earlier wording.",
      developedBy: TEAM,
      evidence: "Benchmark: NHANES published distributions by age (proxy-reported under 16).",
      decisions: ["D-91"],
    },
    background_noise: {
      kind: "existing_items",
      basedOn:
        "UK Biobank touchscreen data-field 2257, 'Hearing difficulty with background noise': “Do you find it difficult to follow a conversation if there is background noise (such as TV, radio, children playing)?” Answers Yes / No / Do not know / Prefer not to answer.",
      adaptations:
        "Wording unchanged. 'Yes' split into 'Yes, all or most of the time' and 'Yes, sometimes' (combine 1 and 2 to compare with UK Biobank's 'Yes'); 'Prefer not to answer' left out, since any question can be skipped. Where the split comes from is not recorded.",
      developedBy: TEAM,
      evidence: "Benchmark: UK Biobank, adults aged 40-69, so a comparison in kind only.",
      decisions: ["D-91"],
    },
  },
  ybm_under16_ban: {
    support: added(
      ["D-92"],
      "The parents' question in the same words (“How much do you support or oppose the planned ban on social media for under-16s?”, strongly oppose to strongly support, plus I don't know), as given by the PI. The middle labels (Oppose / Neither support nor oppose / Support) are the team's; to match to the parents' version. The line of context (apps covered; messaging apps not) is carried over from D-89. Replaces the agree-disagree question ybm_online_life.under16_ban (D-89), whose answers stay in the releases that asked it.",
    ),
    effect: added(
      ["D-92"],
      "The parents' question (“If the ban goes ahead, what effect do you think it will have on [child's name]?”, a very bad effect through no real effect to a very good effect, plus I don't know) asked about the pupil themselves. 'A fairly bad effect' and 'A fairly good effect' are the team's labels for the in-between points; to match to the parents' version.",
    ),
  },
  ybm_online_life: {
    shopping_frequency: added(["D-89"], "Study-written, November 2026. Examples (Vinted, eBay, Depop, Amazon) chosen because selling and shopping apps were reported as being considered for the under-16 ban. No benchmark."),
    shopping_activity: added(["D-89"], "Study-written, November 2026. Asked unless shopping_freq = never. No benchmark."),
  },
  ybm_ai_chatbots: {
    heard: pew("TCHATAWARE", "How much have you heard about artificial intelligence (AI) chatbots like ChatGPT, Copilot or Character.ai?", SAME, "a lot 56%, a little 39%, nothing at all 5%."),
    use: pew("TCHATUSE", "Do you ever use an artificial intelligence (AI) chatbot like ChatGPT, Copilot or Character.ai?", `${SAME} Asked, as by Pew, only of those who have heard a lot or a little.`, "67% of those who had heard of chatbots said yes; 64% of all teens."),
    frequency: pew(
      "TCHATFREQ",
      "About how often do you use an artificial intelligence (AI) chatbot like ChatGPT, Copilot or Character.ai?",
      `${SAME} Asked of users, as by Pew.`,
      "of users: almost constantly 6%, several times a day 19%, about once a day 19%, several times a week 27%, less often 28%. Of all teens, 28% use one daily or more.",
      "dec",
    ),
    felt_friend: {
      kind: "researcher_developed",
      developedBy: TEAM,
      basedOn: "Worded to match the category Ofcom reports for children's AI use, 'as a friend or someone to talk to' (Children and Parents: Media Use and Attitudes 2026: 11% of 8-17 AI users). Ofcom's own question wording was not available.",
      evidence: "No direct benchmark: the wording is the team's. In place of the PI's draft 'a friend, companion, or romantic interest'; 'romantic' was left out for a sample that starts at 11.",
      decisions: ["D-88"],
    },
    why_not_person: added(["D-88"], "Options from the PI's draft list (November 2026), with 'None of these'. No benchmark."),
    school_share: pew("TCHATFREQ2", "How much of your schoolwork would you say you do with the help of artificial intelligence (AI) chatbots?", `${SAME} Asked, as by Pew, of those who use chatbots for schoolwork.`, "all or almost all 5%, most 14%, some 39%, a little 42% (of teens who use them for schoolwork)."),
    school_helpful: pew("TCHATHELPFUL", "Overall, how helpful have artificial intelligence (AI) chatbots been for completing your schoolwork?", `${SAME} Pew rotates the answer order; here always extremely to not at all.`, "extremely 14%, very 33%, somewhat 46%, not too 6%, not at all under 0.5% (of teens who use them for schoolwork)."),
    school_maths: pew("TCHATSCH1 (a)", SCH1, `${ROW("Solving a math problem")} 'math' as 'maths'.`, ofSchool(79)),
    school_editing: pew("TCHATSCH1 (b)", SCH1, ROW("Editing something you wrote"), ofSchool(64)),
    school_research: pew("TCHATSCH1 (c)", SCH1, ROW("Researching a topic"), ofSchool(89)),
    cheating: pew(
      "TCHATSCH2",
      "As far as you know, how often do students at your school use artificial intelligence (AI) chatbots to cheat on their schoolwork?",
      `${SAME} Pew rotates the order 1-5 or 5-1, anchoring 'Not sure'; here always extremely often to never. Pew asks those who have heard of chatbots and are not home-schooled; here, those who have heard of them.`,
      "extremely often 15%, very often 24%, somewhat often 28%, rarely 12%, never 4%, not sure 17%.",
    ),
  },
  ybm_ai_tools: {
    chatbots: {
      kind: "existing_items",
      basedOn: `${PEW_SURVEY} Question TCHATSPEC: “${SPEC}” Rows: ChatGPT, Claude, Gemini, Copilot, Meta AI, Character.ai. Topline: ${PEW_TOPLINE_DEC}.`,
      adaptations:
        "Asked as one select-all list (Pew asks Yes/No for each chatbot, in random order); 'Snapchat's My AI' and 'Something else' added. Replaces the seven Yes/No questions of D-88 (ybm_ai_chatbots.tool_*), whose answers stay in the releases that asked them.",
      developedBy: TEAM,
      evidence:
        "Pew result (US teens 13-17 who use AI chatbots, topline of 9 December 2025): ChatGPT 92%, Gemini 36%, Meta AI 31%, Copilot 23%, Character.ai 14%, Claude 5%. A select-all list may give lower figures than Pew's Yes/No format.",
      decisions: ["D-88", "D-93"],
    },
    chatbots_other: added(["D-93"], "Study-written follow-up for 'Something else'. No benchmark."),
  },
  ybm_ai_uses: {
    purposes: {
      kind: "existing_items",
      basedOn: `${PEW_SURVEY} Question TCHATWHY: “${WHY}” Rows: Search for information; Get news; Get help with schoolwork; For fun or entertainment; Create or edit images or videos; Get emotional support or advice; Summarize an article, book, or video; Casual conversation. Topline: ${PEW_TOPLINE_FEB}.`,
      adaptations:
        "Asked as one select-all list (Pew asks Yes/No for each use, in random order), with Pew’s question wording and “Choose all that apply.” under it; 'Something else' added; British spelling. Replaces the eight Yes/No questions of D-88 (ybm_ai_chatbots.for_*), whose answers stay in the releases that asked them.",
      developedBy: TEAM,
      evidence:
        "Pew result (US teens 13-17 who use AI chatbots, topline of 24 February 2026): search for information 89%, schoolwork 85%, fun 74%, summarise 65%, images or videos 59%, news 30%, casual conversation 25%, emotional support or advice 18%. A select-all list may give lower figures than Pew's Yes/No format.",
      decisions: ["D-88", "D-94"],
    },
    purposes_other: added(["D-94"], "Study-written follow-up for 'Something else'. No benchmark."),
  },
  ybm_ai_outlook: {
    impact_society: pew(
      "TAIIMP",
      "Do you think that the impact of artificial intelligence (AI) on society over the next 20 years will be…",
      "Pew's wording. The line under it is Pew's TAIHEARD definition of AI ('Artificial intelligence (AI) is designed to learn tasks that humans typically do, for instance recognizing or generating text or pictures.'), with British spelling. Pew rotates the answer order; here always very positive to very negative, then not sure.",
      "very positive 11%, somewhat positive 20%, equally positive and negative 34%, somewhat negative 18%, very negative 8%, not sure 8%.",
    ),
    impact_self: pew(
      "TAIIMPSELF",
      "And, do you think that the impact of artificial intelligence (AI) on you, personally over the next 20 years will be…",
      `${SAME} Straight after TAIIMP, as in Pew. Pew rotates the answer order in the same way as TAIIMP; here fixed.`,
      "very positive 11%, somewhat positive 25%, equally positive and negative 32%, somewhat negative 12%, very negative 3%, not sure 17%.",
    ),
    worries: added(
      ["D-88"],
      "Study-written, from the PI's draft list (November 2026). Options 1-6 follow the codes Pew gave US teens' open answers on why AI will have a negative impact (TIMPOE_N: overreliance 34%, job loss 25%, misinformation 13%, misuse or threat 13%, loss of human factor 6%, environment 6%), so they can be compared in kind but not as a benchmark: Pew's question was open-ended and asked only of those expecting a negative impact.",
    ),
    spot_confidence: added(
      ["D-88"],
      "Study-written. Ofcom asks children about their confidence in identifying AI-generated content and tests it with an image (Children and Parents: Media Use and Attitudes 2026); its wording was not available, so this is not a benchmark.",
    ),
    talked: added(["D-88"], "Study-written, from the PI's draft list (November 2026). Pew asked parents, not teens, whether they talk with their teen about chatbots, so there is no teen benchmark. The last answer reads 'No' (D-94; it read 'No, not really' until 23.0.0, same value)."),
  },

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
