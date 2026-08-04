import { useMemo, useState } from "react";
import {
  ADAPT_SYSTEM,
  EXTRACTION_SYSTEM,
  INTERVIEWER_SYSTEM,
  NO_SAFEGUARDING_STATED,
  SCENARIO_SYSTEM,
  checkProtocol,
  collectionComplete,
  configFromProtocol,
  keyQuestions,
  keysString,
  numberedQuestions,
  oneShot,
  parseProtocolFile,
  protocolFromConfig,
  protocolToToml,
  protocols,
  type NarrativeProtocol,
  type ProtocolConfig,
} from "@myself/narrative";

/**
 * MyStory — the protocol editor.
 *
 * A study is a configuration file (docs/08 §10.5). This is the same file with
 * boxes round it: change the questions, the personas, the keys to extract
 * into, the words a participant reads, and the model — then read the four
 * prompts that will actually be sent, and download the file to commit.
 *
 * Three things it deliberately does.
 *
 * IT SHOWS THE ASSEMBLED PROMPTS, not the templates. What a researcher wants
 * to know is what the interviewer will be told, and that only exists once
 * their persona, their questions and their topic restriction have been put
 * into it. Reading it before fielding is how you notice that question four
 * asks something you did not mean.
 *
 * IT RUNS THE PUBLISH GATE ON EVERY KEYSTROKE. A mistyped {placeholder}, a
 * name heading for a provider, a persona list of one — all visible while the
 * cause is still on screen, rather than at publish time a week later.
 *
 * IT DOES NOT SAVE ANYWHERE. The output is a file. A protocol that ran a
 * study has to be in version control with everything else that produced the
 * data, not in a database row somebody edited on a Tuesday.
 */

const scratch = (protocol: NarrativeProtocol) => {
  try {
    return { config: configFromProtocol(protocol), error: null as string | null };
  } catch (error) {
    return { config: null, error: (error as Error).message };
  }
};

type Draft = ProtocolConfig;

export function Protocols() {
  const [source, setSource] = useState<string>(protocols[0]!.key);
  const [draft, setDraft] = useState<Draft | null>(() => scratch(protocols[0]!).config);
  const [loadError, setLoadError] = useState<string | null>(() => scratch(protocols[0]!).error);
  const [view, setView] = useState<"study" | "prompts" | "file">("study");
  const [copied, setCopied] = useState(false);

  /** The protocol the draft currently describes, or why it is not one yet. */
  const built = useMemo(() => {
    if (!draft) return { protocol: null as NarrativeProtocol | null, error: loadError };
    try {
      return { protocol: protocolFromConfig(draft), error: null as string | null };
    } catch (error) {
      return { protocol: null, error: (error as Error).message };
    }
  }, [draft, loadError]);

  const problems = useMemo(
    () => (built.protocol ? checkProtocol(built.protocol) : []),
    [built.protocol],
  );

  const edit = (change: (d: Draft) => Draft) => {
    setDraft((current) => (current ? change(structuredClone(current)) : current));
    setCopied(false);
  };

  const pickShipped = (key: string) => {
    const protocol = protocols.find((p) => p.key === key);
    setSource(key);
    if (!protocol) return;
    const result = scratch(protocol);
    setDraft(result.config);
    setLoadError(result.error);
  };

  const openFile = async (file: File) => {
    const text = await file.text();
    try {
      const protocol = parseProtocolFile(text, file.name);
      const result = scratch(protocol);
      setDraft(result.config);
      setLoadError(result.error);
      setSource(file.name);
    } catch (error) {
      setDraft(null);
      setLoadError((error as Error).message);
      setSource(file.name);
    }
  };

  const toml = useMemo(() => {
    if (!built.protocol) return "";
    try {
      return protocolToToml(built.protocol);
    } catch (error) {
      return `# ${(error as Error).message}\n`;
    }
  }, [built.protocol]);

  const download = () => {
    const stem = (built.protocol?.key ?? "study").replace(/^np\./, "");
    const url = URL.createObjectURL(new Blob([toml], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}.toml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel protocols">
      <h2>MyStory protocols</h2>
      <p className="note">
        A study is a configuration file, in the same format the micro-narratives app reads. Edit it here or edit the
        file — they are the same thing. Nothing is saved on this machine: the output is a <code>.toml</code> to commit
        beside the release that used it.
      </p>

      <div className="protocol-source">
        <label className="field-label" htmlFor="protocol-pick">
          Start from
        </label>
        <select id="protocol-pick" value={source} onChange={(e) => pickShipped(e.target.value)}>
          {protocols.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} ({p.key})
            </option>
          ))}
          {!protocols.some((p) => p.key === source) && <option value={source}>{source}</option>}
        </select>
        <label className="secondary file-button">
          Open a .toml
          <input
            type="file"
            accept=".toml,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openFile(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {built.error && (
        <div className="alert">
          <strong>This file will not load.</strong>
          <p>{built.error}</p>
        </div>
      )}

      {draft && built.protocol && (
        <>
          <Gate problems={problems} protocol={built.protocol} />

          <nav className="tabs inner">
            {(["study", "prompts", "file"] as const).map((v) => (
              <button key={v} type="button" className={view === v ? "tab on" : "tab"} onClick={() => setView(v)}>
                {v === "study" ? "The study" : v === "prompts" ? "What gets sent" : "The file"}
              </button>
            ))}
          </nav>

          {view === "study" && <StudyForm draft={draft} edit={edit} />}
          {view === "prompts" && <Prompts protocol={built.protocol} />}
          {view === "file" && (
            <div className="protocol-file">
              <div className="protocol-file-actions">
                <button type="button" className="primary" onClick={download}>
                  Download {(built.protocol.key ?? "study").replace(/^np\./, "")}.toml
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(toml);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="protocol-pre">{toml}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Gate({ problems, protocol }: { problems: string[]; protocol: NarrativeProtocol }) {
  const unstated = protocol.safeguardingDeclaration === NO_SAFEGUARDING_STATED;
  const identifiers = protocol.permittedIdentifiers;

  return (
    <div className={problems.length > 0 ? "alert" : "alert quiet"}>
      {problems.length > 0 ? (
        <>
          <strong>
            {problems.length} thing{problems.length === 1 ? "" : "s"} would stop this being published
          </strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      ) : (
        <strong>This protocol passes the publish gate.</strong>
      )}

      {identifiers.length > 0 && (
        <p>
          <strong>This study sends identifiers to the model provider:</strong> {identifiers.join(", ")}. Every call
          that carries one is flagged in the provenance. The consent wording has to say so.
        </p>
      )}

      {unstated && (
        <p>
          No safeguarding declaration. The protocol will run here and in the lab, and it cannot go into a release
          until somebody writes down what happens if a participant says something frightening.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the study form */

const Field = ({
  label,
  hint,
  value,
  rows,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  rows?: number;
  onChange: (v: string) => void;
}) => (
  <label className="protocol-field">
    <span className="field-label">{label}</span>
    {hint && <span className="dim">{hint}</span>}
    {rows ? (
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    ) : (
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    )}
  </label>
);

/** A list of strings, added to and removed from. Used for the question list. */
function ListField({
  label,
  hint,
  values,
  onChange,
  addLabel,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="protocol-field">
      <span className="field-label">{label}</span>
      {hint && <span className="dim">{hint}</span>}
      {values.map((value, index) => (
        <div className="protocol-row" key={index}>
          <span className="protocol-index">{index + 1}</span>
          <textarea
            rows={2}
            value={value}
            onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            disabled={values.length <= 1}
            title={values.length <= 1 ? "A study with no questions collects nothing" : "Remove"}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => onChange([...values, ""])}>
        {addLabel}
      </button>
    </div>
  );
}

/** A keyed table: extraction keys, and personas. Both are name → text. */
function KeyedField({
  label,
  hint,
  entries,
  onChange,
  addLabel,
  rows,
  minimum,
}: {
  label: string;
  hint?: string;
  entries: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  addLabel: string;
  rows: number;
  minimum: number;
}) {
  const list = Object.entries(entries);
  const replace = (next: [string, string][]) => onChange(Object.fromEntries(next));

  return (
    <div className="protocol-field">
      <span className="field-label">{label}</span>
      {hint && <span className="dim">{hint}</span>}
      {list.map(([key, value], index) => (
        <div className="protocol-row keyed" key={index}>
          <input
            type="text"
            className="protocol-key"
            value={key}
            onChange={(e) => replace(list.map((entry, i) => (i === index ? [e.target.value, entry[1]] : entry)))}
          />
          <textarea
            rows={rows}
            value={value}
            onChange={(e) => replace(list.map((entry, i) => (i === index ? [entry[0], e.target.value] : entry)))}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => replace(list.filter((_, i) => i !== index))}
            disabled={list.length <= minimum}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => replace([...list, ["", ""]])}>
        {addLabel}
      </button>
    </div>
  );
}

function StudyForm({ draft, edit }: { draft: Draft; edit: (change: (d: Draft) => Draft) => void }) {
  return (
    <div className="protocol-form">
      <h3>The conversation</h3>
      <Field
        label="Interviewer"
        hint="Who the model is, in its own words. This goes into the prompt exactly as written."
        rows={3}
        value={draft.collection.persona}
        onChange={(v) => edit((d) => ({ ...d, collection: { ...d.collection, persona: v } }))}
      />
      <Field
        label="How it should speak"
        hint="Reading level, register, sentence length."
        rows={2}
        value={draft.collection.language_type}
        onChange={(v) => edit((d) => ({ ...d, collection: { ...d.collection, language_type: v } }))}
      />
      <Field
        label="Opening"
        hint="What the participant reads before the first question. {previous_scenario} pipes in what they said last wave."
        rows={4}
        value={draft.collection.intro}
        onChange={(v) => edit((d) => ({ ...d, collection: { ...d.collection, intro: v } }))}
      />
      <ListField
        label="Questions"
        hint="Asked one at a time, in order, conversationally."
        values={draft.collection.questions}
        addLabel="Add a question"
        onChange={(v) => edit((d) => ({ ...d, collection: { ...d.collection, questions: v } }))}
      />
      <Field
        label="Staying on topic"
        hint="What the model does when a participant raises something else."
        rows={3}
        value={draft.collection.topic_restriction}
        onChange={(v) => edit((d) => ({ ...d, collection: { ...d.collection, topic_restriction: v } }))}
      />

      <h3>What is taken from it</h3>
      <KeyedField
        label="Extraction keys"
        hint="A short name, and the question it answers. A key nothing answers comes back null, which is a result."
        entries={draft.summaries.questions}
        rows={2}
        minimum={1}
        addLabel="Add a key"
        onChange={(v) => edit((d) => ({ ...d, summaries: { ...d.summaries, questions: v } }))}
      />

      <h3>Who retells it</h3>
      <KeyedField
        label="Personas"
        hint="A name, and the voice. The name is stored with the retelling, so which voice a participant chose is analysable."
        entries={draft.summaries.personas}
        rows={4}
        minimum={2}
        addLabel="Add a persona"
        onChange={(v) => edit((d) => ({ ...d, summaries: { ...d.summaries, personas: v } }))}
      />
      <Field
        label="Example conversation"
        hint="The one-shot that sets the register. Shown to every persona."
        rows={6}
        value={draft.example.conversation}
        onChange={(v) => edit((d) => ({ ...d, example: { ...d.example, conversation: v } }))}
      />
      <Field
        label="Example retelling"
        rows={4}
        value={draft.example.scenario}
        onChange={(v) => edit((d) => ({ ...d, example: { ...d.example, scenario: v } }))}
      />

      <h3>What the participant reads</h3>
      <Field
        label="Consent page"
        rows={6}
        value={draft.consent.intro_and_consent}
        onChange={(v) => edit((d) => ({ ...d, consent: { intro_and_consent: v } }))}
      />
      <Field
        label="Choosing"
        value={draft.myself.select_text}
        onChange={(v) => edit((d) => ({ ...d, myself: { ...d.myself, select_text: v } }))}
      />
      <Field
        label="Rating"
        value={draft.myself.rate_text}
        onChange={(v) => edit((d) => ({ ...d, myself: { ...d.myself, rate_text: v } }))}
      />
      <Field
        label="Correcting"
        value={draft.myself.adapt_text}
        onChange={(v) => edit((d) => ({ ...d, myself: { ...d.myself, adapt_text: v } }))}
      />
      <Field
        label="Closing"
        rows={3}
        value={draft.myself.debrief_text}
        onChange={(v) => edit((d) => ({ ...d, myself: { ...d.myself, debrief_text: v } }))}
      />

      <h3>The model</h3>
      <div className="protocol-grid">
        <label className="protocol-field">
          <span className="field-label">Model</span>
          <input
            type="text"
            value={draft.model}
            onChange={(e) => edit((d) => ({ ...d, model: e.target.value }))}
          />
        </label>
        <label className="protocol-field">
          <span className="field-label">Temperature</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={draft.myself.temperature}
            onChange={(e) =>
              edit((d) => ({ ...d, myself: { ...d.myself, temperature: Number(e.target.value) } }))
            }
          />
        </label>
        <label className="protocol-field">
          <span className="field-label">Longest interview</span>
          <input
            type="number"
            min={1}
            max={40}
            value={draft.myself.max_turns}
            onChange={(e) => edit((d) => ({ ...d, myself: { ...d.myself, max_turns: Number(e.target.value) } }))}
          />
        </label>
      </div>
      <p className="dim">
        Extraction always runs at 0.1 whatever this says — it is the one stage that must not improvise.
      </p>

      <h3>Safety and data protection</h3>
      <Field
        label="Safeguarding declaration"
        hint={'Required before this can be fielded. "No automated rules; researcher review only" is a good answer.'}
        rows={4}
        value={draft.myself.safeguarding_declaration ?? ""}
        onChange={(v) =>
          edit((d) => ({ ...d, myself: { ...d.myself, safeguarding_declaration: v || undefined } }))
        }
      />
      <Field
        label="Variables allowed on screen"
        hint="Comma separated. A placeholder not listed here is left as written."
        value={draft.myself.permitted_variables.join(", ")}
        onChange={(v) =>
          edit((d) => ({
            ...d,
            myself: {
              ...d.myself,
              permitted_variables: v.split(",").map((s) => s.trim()).filter(Boolean),
            },
          }))
        }
      />
      <Field
        label="Identifiers allowed into prompts"
        hint="Usually empty. Anything here is sent to the model provider, and the consent wording has to say so."
        value={draft.myself.permitted_identifiers.join(", ")}
        onChange={(v) =>
          edit((d) => ({
            ...d,
            myself: {
              ...d.myself,
              permitted_identifiers: v.split(",").map((s) => s.trim()).filter(Boolean),
            },
          }))
        }
      />
      <label className="protocol-check">
        <input
          type="checkbox"
          checked={draft.quality_control_flagging}
          onChange={(e) => edit((d) => ({ ...d, quality_control_flagging: e.target.checked }))}
        />
        <span>
          Typing-dynamics quality control. Aimed at crowdsourced adult panels. In a school a child who composes in
          Notes and pastes is not a bot — leave it off unless the sample is one where pasting means something.
        </span>
      </label>
    </div>
  );
}

/* --------------------------------------------------------- assembled prompts */

/**
 * The four prompts, assembled the way the runner assembles them.
 *
 * Session variables are left standing: `{topic}` is resolved per participant,
 * and showing a made-up value here would misrepresent what is fixed.
 */
function Prompts({ protocol }: { protocol: NarrativeProtocol }) {
  const interview = protocol.interview;
  const keys = protocol.extraction?.keys ?? {};

  const interviewer =
    interview &&
    INTERVIEWER_SYSTEM.replace("{persona}", interview.persona)
      .replace("{language_style}", interview.languageStyle)
      .replace("{topic_restriction}", interview.topicRestriction)
      .replace("{questions}", numberedQuestions(interview.questions))
      .replace("{collection_complete}", collectionComplete(interview.questions.length));

  const extraction = EXTRACTION_SYSTEM.replace("{keys_string}", keysString(Object.keys(keys))).replace(
    "{questions}",
    keyQuestions(keys),
  );

  return (
    <div className="protocol-prompts">
      <p className="note">
        Exactly what will be sent, once this study&apos;s own words are in the templates. Placeholders like{" "}
        <code>{"{topic}"}</code> are resolved per participant and are left standing here.
      </p>

      {interviewer && (
        <details open>
          <summary>The interviewer — sent on every turn of the conversation</summary>
          <pre className="protocol-pre">{interviewer}</pre>
        </details>
      )}

      <details>
        <summary>Extraction — sent once, when the interview closes</summary>
        <pre className="protocol-pre">{extraction}</pre>
      </details>

      {protocol.scenario?.personas.map((persona) => (
        <details key={persona.key}>
          <summary>Retelling as &lsquo;{persona.key}&rsquo; — one call per persona</summary>
          <pre className="protocol-pre">
            {SCENARIO_SYSTEM.replace("{persona}", persona.text).replace("{one_shot}", oneShot(protocol))}
          </pre>
        </details>
      ))}

      <details>
        <summary>Correction — sent only if the participant asks for a change</summary>
        <pre className="protocol-pre">{ADAPT_SYSTEM}</pre>
      </details>
    </div>
  );
}
