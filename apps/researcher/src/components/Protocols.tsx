import { useEffect, useMemo, useRef, useState } from "react";
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
  protocolConfig,
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
 * boxes round it: open it, see everything in it, change any of it, and write
 * it back.
 *
 * Four things it deliberately does.
 *
 * IT SHOWS EVERY FIELD THE FILE CAN CARRY. It used to show about half of
 * them — the questions, the personas, four of the participant-facing lines —
 * and silently pass the rest through. A researcher who opened a file to check
 * the age range, or the character, or what happens with no network, could not
 * see any of those, and a field an editor does not show is a field nobody
 * reviews. Anything left blank still falls back to the schema's default; the
 * point is that the default is now visible rather than hidden.
 *
 * IT SHOWS THE ASSEMBLED PROMPTS, not the templates. What a researcher wants
 * to know is what the interviewer will be told, and that only exists once
 * their persona, their questions and their topic restriction have been put
 * into it. Reading it before fielding is how you notice that question four
 * asks something you did not mean.
 *
 * IT CHECKS ON EVERY KEYSTROKE — both the schema and the publish gate. A
 * mistyped {placeholder}, a key that is not `np.something`, a name heading
 * for a provider, a persona list of one: all visible while the cause is still
 * on screen rather than at publish time a week later.
 *
 * AND WHAT IT SAVES IS STILL A FILE. Save writes back to the .toml that was
 * opened, where the browser allows it, and downloads one where it does not.
 * There is deliberately no database row: a protocol that ran a study has to
 * be in version control with everything else that produced the data.
 */

/* The File System Access API, which is how "Save" saves. Declared here
   because it is not in every TypeScript DOM lib yet, and narrowly: the two
   calls this needs and nothing else. */
interface WritableFile {
  write: (contents: string) => Promise<void>;
  close: () => Promise<void>;
}
interface FileHandle {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableFile>;
  queryPermission?: (opts: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "readwrite" }) => Promise<PermissionState>;
}
type Picker = (options?: unknown) => Promise<FileHandle[]>;
const filePicker = (): Picker | null =>
  (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker ?? null;

const scratch = (protocol: NarrativeProtocol) => {
  try {
    return { config: configFromProtocol(protocol), error: null as string | null };
  } catch (error) {
    return { config: null, error: (error as Error).message };
  }
};

type Draft = ProtocolConfig;

/** Where the draft on screen came from, so the banner can say so. */
type Origin = { kind: "shipped" | "file"; label: string };

/**
 * Edits survive a reload.
 *
 * Half an hour of careful wording lost to a stray refresh is the kind of thing
 * that stops people using an editor at all. Kept on this machine only, and
 * only until it is saved or discarded.
 */
const DRAFT_KEY = "myself.protocol.draft.v1";

export function Protocols() {
  const first = protocols[0]!;
  const [source, setSource] = useState<string>(first.key);
  const [origin, setOrigin] = useState<Origin>({ kind: "shipped", label: first.name });
  const [draft, setDraft] = useState<Draft | null>(() => scratch(first).config);
  const [loadError, setLoadError] = useState<string | null>(() => scratch(first).error);
  const [view, setView] = useState<"study" | "prompts" | "file">("study");
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const handle = useRef<FileHandle | null>(null);

  /* Put back an unsaved draft, once, on the way in. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { draft: Draft; source: string; origin: Origin };
      if (!saved?.draft) return;
      setDraft(saved.draft);
      setSource(saved.source);
      setOrigin(saved.origin);
      setDirty(true);
      setRestored(true);
    } catch {
      // A draft that will not parse is not worth an error message: the
      // shipped protocol is already on screen behind it.
    }
  }, []);

  /* And keep it, as it is typed. */
  useEffect(() => {
    if (!dirty || !draft) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft, source, origin }));
    } catch {
      // Full or disabled. The editor still works; only the safety net is gone.
    }
  }, [draft, dirty, source, origin]);

  const forgetDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* see above */
    }
    setRestored(false);
  };

  /** What the schema makes of the draft — the first thing that can be wrong. */
  const schema = useMemo(() => {
    if (!draft) return { ok: true, issues: [] as string[] };
    const result = protocolConfig.safeParse(draft);
    return result.success
      ? { ok: true, issues: [] as string[] }
      : { ok: false, issues: result.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`) };
  }, [draft]);

  /** The protocol the draft currently describes, or why it is not one yet. */
  const built = useMemo(() => {
    if (!draft) return { protocol: null as NarrativeProtocol | null, error: loadError };
    try {
      return { protocol: protocolFromConfig(draft), error: null as string | null };
    } catch (error) {
      return { protocol: null, error: (error as Error).message };
    }
  }, [draft, loadError]);

  const problems = useMemo(() => (built.protocol ? checkProtocol(built.protocol) : []), [built.protocol]);

  const edit = (change: (d: Draft) => Draft) => {
    setDraft((current) => (current ? change(structuredClone(current)) : current));
    setCopied(false);
    setDirty(true);
    setNote(null);
  };

  const load = (config: Draft | null, error: string | null, next: Origin, key: string) => {
    setDraft(config);
    setLoadError(error);
    setOrigin(next);
    setSource(key);
    setDirty(false);
    setNote(null);
    forgetDraft();
  };

  const pickShipped = (key: string) => {
    const protocol = protocols.find((p) => p.key === key);
    if (!protocol) return;
    handle.current = null;
    const result = scratch(protocol);
    load(result.config, result.error, { kind: "shipped", label: protocol.name }, key);
  };

  const readText = (text: string, name: string) => {
    try {
      const protocol = parseProtocolFile(text, name);
      const result = scratch(protocol);
      load(result.config, result.error, { kind: "file", label: name }, name);
    } catch (error) {
      load(null, (error as Error).message, { kind: "file", label: name }, name);
    }
  };

  /**
   * Open through the picker when the browser has one, so Save can write back
   * to the same file. The plain input is the fallback, and everything works
   * through it except saving in place.
   */
  const openViaPicker = async () => {
    const picker = filePicker();
    if (!picker) return false;
    try {
      const [chosen] = await picker({
        types: [{ description: "Protocol file", accept: { "text/plain": [".toml"], "application/json": [".json"] } }],
        excludeAcceptAllOption: false,
        multiple: false,
      });
      if (!chosen) return true;
      handle.current = chosen;
      const file = await chosen.getFile();
      readText(await file.text(), chosen.name);
    } catch (error) {
      // An abort is somebody changing their mind, not a fault.
      if ((error as { name?: string }).name !== "AbortError") setNote(`Could not open that: ${(error as Error).message}`);
    }
    return true;
  };

  const toml = useMemo(() => {
    if (!built.protocol) return "";
    try {
      return protocolToToml(built.protocol);
    } catch (error) {
      return `# ${(error as Error).message}\n`;
    }
  }, [built.protocol]);

  const fileStem = (built.protocol?.key ?? "study").replace(/^np\./, "");

  const download = () => {
    const url = URL.createObjectURL(new Blob([toml], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileStem}.toml`;
    a.click();
    URL.revokeObjectURL(url);
    setDirty(false);
    forgetDraft();
    setNote(`Downloaded ${fileStem}.toml. Commit it beside the release that uses it.`);
  };

  /** Write it back where it came from, or fall back to downloading a copy. */
  const save = async () => {
    const target = handle.current;
    if (!target) {
      download();
      return;
    }
    try {
      const granted =
        (await target.queryPermission?.({ mode: "readwrite" })) ??
        (await target.requestPermission?.({ mode: "readwrite" })) ??
        "granted";
      if (granted !== "granted") {
        const asked = (await target.requestPermission?.({ mode: "readwrite" })) ?? "denied";
        if (asked !== "granted") {
          setNote("The browser would not give permission to write to that file. Download a copy instead.");
          return;
        }
      }
      const writable = await target.createWritable();
      await writable.write(toml);
      await writable.close();
      setDirty(false);
      forgetDraft();
      setNote(`Saved to ${target.name}.`);
    } catch (error) {
      setNote(`Could not save: ${(error as Error).message}. Download a copy instead.`);
    }
  };

  const revert = () => {
    if (origin.kind === "shipped") {
      pickShipped(source);
      return;
    }
    setNote("Open the file again to go back to what is on disk.");
    forgetDraft();
  };

  const canSaveInPlace = handle.current !== null;

  return (
    <section className="panel protocols">
      <h2>MyStory protocols</h2>
      <p className="note">
        A study is a configuration file, in the same format the micro-narratives app reads. Everything the file can
        carry is on this page. What comes out is a <code>.toml</code> to commit beside the release that used it — there
        is no database row, because a protocol that ran a study belongs in version control with the data it produced.
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
            onClick={(e) => {
              // The picker gives a handle Save can write back to; the plain
              // input cannot. Prefer it where it exists.
              if (filePicker()) {
                e.preventDefault();
                void openViaPicker();
              }
            }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handle.current = null;
                void file.text().then((text) => readText(text, file.name));
              }
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {/* What is open, said plainly. Loading a file used to change nothing on
          screen except one option in a dropdown, so there was no way to tell
          whether it had worked. */}
      <div className={draft ? "protocol-loaded" : "protocol-loaded bad"}>
        <div>
          <strong>
            {origin.kind === "file" ? "File" : "Shipped protocol"}: {origin.label}
          </strong>
          {built.protocol && (
            <span className="dim">
              {" "}
              — {built.protocol.key}@{built.protocol.version} · {built.protocol.stages.length} stages ·{" "}
              {built.protocol.interview?.questions.length ?? 0} questions ·{" "}
              {built.protocol.scenario?.personas.length ?? 0} personas
            </span>
          )}
          {!draft && <span className="dim"> — did not load</span>}
        </div>
        <div className="protocol-save">
          {dirty ? <span className="pill warn">Unsaved changes</span> : <span className="pill">Saved</span>}
          <button type="button" className="primary" onClick={() => void save()} disabled={!built.protocol}>
            {canSaveInPlace ? `Save to ${origin.label}` : `Save as ${fileStem}.toml`}
          </button>
          <button type="button" className="secondary" onClick={download} disabled={!built.protocol}>
            Download a copy
          </button>
          {dirty && (
            <button type="button" className="secondary" onClick={revert}>
              Discard changes
            </button>
          )}
        </div>
      </div>

      {restored && (
        <div className="alert quiet">
          <strong>Unsaved edits from last time have been put back.</strong>
          <p>They were kept on this machine only. Save them to a file, or discard them.</p>
        </div>
      )}

      {note && <div className="alert quiet">{note}</div>}

      {built.error && (
        <div className="alert">
          <strong>This file will not load.</strong>
          <p>{built.error}</p>
        </div>
      )}

      {!schema.ok && (
        <div className="alert">
          <strong>Not a valid configuration yet</strong>
          <ul>
            {schema.issues.slice(0, 8).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
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
                <button type="button" className="primary" onClick={() => void save()}>
                  {canSaveInPlace ? `Save to ${origin.label}` : `Download ${fileStem}.toml`}
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

/* ------------------------------------------------------------ small inputs */

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

const NumberField = ({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) => (
  <label className="protocol-field">
    <span className="field-label">{label}</span>
    {hint && <span className="dim">{hint}</span>}
    <input
      type="number"
      value={value}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(step === undefined ? {} : { step })}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </label>
);

function SelectField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="protocol-field">
      <span className="field-label">{label}</span>
      {hint && <span className="dim">{hint}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const CheckField = ({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) => (
  <label className="protocol-check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>{children}</span>
  </label>
);

/** A list of strings, added to and removed from. */
function ListField({
  label,
  hint,
  values,
  onChange,
  addLabel,
  rows = 2,
  minimum = 1,
  emptyNote,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  addLabel: string;
  rows?: number;
  minimum?: number;
  emptyNote?: string;
}) {
  return (
    <div className="protocol-field">
      <span className="field-label">{label}</span>
      {hint && <span className="dim">{hint}</span>}
      {values.length === 0 && emptyNote && <span className="dim">{emptyNote}</span>}
      {values.map((value, index) => (
        <div className="protocol-row" key={index}>
          <span className="protocol-index">{index + 1}</span>
          <textarea
            rows={rows}
            value={value}
            onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            disabled={values.length <= minimum}
            title={values.length <= minimum ? "There has to be at least one" : "Remove"}
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

/* ------------------------------------------------------------ the study form */

type Myself = Draft["myself"];
type Rule = Myself["safeguarding"][number];

function StudyForm({ draft, edit }: { draft: Draft; edit: (change: (d: Draft) => Draft) => void }) {
  /** Every field under [myself] goes through here, so the spread is written once. */
  const my = (patch: Partial<Myself>) => edit((d) => ({ ...d, myself: { ...d.myself, ...patch } }));
  const character = draft.myself.character ?? {};
  const commas = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <div className="protocol-form">
      <h3>This study</h3>
      <div className="protocol-grid">
        <Field
          label="Key"
          hint="np.something_short"
          value={draft.myself.key ?? ""}
          onChange={(v) => my({ key: v || undefined })}
        />
        <Field label="Version" value={draft.myself.version ?? ""} onChange={(v) => my({ version: v || undefined })} />
        <Field label="Language" value={draft.myself.language} onChange={(v) => my({ language: v })} />
        <SelectField
          label="Approval"
          value={draft.myself.approval_status}
          options={[
            { value: "draft", label: "Draft" },
            { value: "in_review", label: "In review" },
            { value: "approved", label: "Approved" },
          ]}
          onChange={(v) => my({ approval_status: v })}
        />
      </div>
      <Field label="Name" value={draft.myself.name ?? ""} onChange={(v) => my({ name: v || undefined })} />
      <Field
        label="Research question"
        hint="What this study is for, in one sentence. It travels with the data."
        rows={2}
        value={draft.myself.research_question ?? ""}
        onChange={(v) => my({ research_question: v || undefined })}
      />
      <div className="protocol-grid">
        <Field label="Owner" value={draft.myself.owner ?? ""} onChange={(v) => my({ owner: v || undefined })} />
        <NumberField
          label="Minutes (estimate)"
          value={draft.myself.estimated_minutes}
          min={1}
          onChange={(v) => my({ estimated_minutes: v })}
        />
        <NumberField
          label="Youngest age"
          value={draft.myself.age_min ?? 0}
          min={0}
          onChange={(v) => my({ age_min: v || undefined })}
        />
        <NumberField
          label="Oldest age"
          value={draft.myself.age_max ?? 0}
          min={0}
          onChange={(v) => my({ age_max: v || undefined })}
        />
      </div>

      <h3>Who they think they are talking to</h3>
      <p className="dim">
        The cohort decides this. A ten-year-old holds onto &ldquo;it is a robot called Botty&rdquo; in a way they do not
        hold onto a name; a sixteen-year-old dismisses a robot as something made for children. Both have to disclose
        that it is an AI, and the publish gate checks that one of the lines below says so.
      </p>
      <div className="protocol-grid">
        <Field label="Name" value={character.name ?? ""} onChange={(v) => my({ character: { ...character, name: v || undefined } })} />
        <Field
          label="What the name means"
          hint="Shown on the profile, e.g. Stories About Me."
          value={character.meaning ?? ""}
          onChange={(v) => my({ character: { ...character, meaning: v || undefined } })}
        />
        <SelectField
          label="Face"
          value={character.look ?? "neutral"}
          options={[
            { value: "robot", label: "A robot" },
            { value: "neutral", label: "A plain mark" },
            { value: "logo", label: "The study's badge" },
          ]}
          onChange={(v) => my({ character: { ...character, look: v } })}
        />
      </div>
      <ListField
        label="Profile lines"
        hint="What the participant reads when they tap the name. One of these must say it is an AI, a robot, a computer program or not a real person."
        values={character.about ?? []}
        minimum={0}
        emptyNote="Nothing here yet — the profile will be empty and the gate will refuse it."
        addLabel="Add a line"
        onChange={(v) => my({ character: { ...character, about: v.length > 0 ? v : undefined } })}
      />

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
      <div className="protocol-grid">
        <NumberField
          label="Longest interview (turns)"
          value={draft.myself.max_turns}
          min={1}
          max={40}
          onChange={(v) => my({ max_turns: v })}
        />
        <NumberField
          label="Shortest answer (characters)"
          value={draft.myself.min_chars}
          min={0}
          onChange={(v) => my({ min_chars: v })}
        />
        <NumberField
          label="Longest answer (characters)"
          value={draft.myself.max_chars}
          min={1}
          onChange={(v) => my({ max_chars: v })}
        />
      </div>

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
      <p className="dim">
        The original hard-codes these in <code>app.py</code>; docs/08 §8.3 lists that as debt, because the phrasing a
        child sees is a study decision. Each stage has a line and a sub-line.
      </p>
      <Field
        label="Consent page"
        rows={6}
        value={draft.consent.intro_and_consent}
        onChange={(v) => edit((d) => ({ ...d, consent: { intro_and_consent: v } }))}
      />
      <Field
        label="Closing the interview"
        hint="Said when the last question has been answered."
        value={draft.myself.outro}
        onChange={(v) => my({ outro: v })}
      />
      <Field label="Choosing" value={draft.myself.select_text} onChange={(v) => my({ select_text: v })} />
      <Field label="Choosing — sub-line" value={draft.myself.select_lede} onChange={(v) => my({ select_lede: v })} />
      <Field label="Rating" value={draft.myself.rate_text} onChange={(v) => my({ rate_text: v })} />
      <Field label="Rating — sub-line" value={draft.myself.rate_lede} onChange={(v) => my({ rate_lede: v })} />
      <Field label="Correcting" value={draft.myself.adapt_text} onChange={(v) => my({ adapt_text: v })} />
      <Field label="Correcting — sub-line" value={draft.myself.adapt_lede} onChange={(v) => my({ adapt_lede: v })} />
      <Field label="Closing" rows={3} value={draft.myself.debrief_text} onChange={(v) => my({ debrief_text: v })} />
      <Field
        label="Closing — sub-line"
        rows={2}
        value={draft.myself.debrief_lede}
        onChange={(v) => my({ debrief_lede: v })}
      />
      <Field
        label="When the model cannot be reached"
        hint="Shown in place of a reply, so a lost connection is not a blank screen."
        rows={2}
        value={draft.myself.fallback_text}
        onChange={(v) => my({ fallback_text: v })}
      />

      <h3>The participant&apos;s own code</h3>
      <CheckField
        checked={draft.participant.require_participant_id}
        onChange={(v) => edit((d) => ({ ...d, participant: { ...d.participant, require_participant_id: v } }))}
      >
        Ask for a participant code before starting.
      </CheckField>
      <CheckField
        checked={draft.participant.editable_participant_id}
        onChange={(v) => edit((d) => ({ ...d, participant: { ...d.participant, editable_participant_id: v } }))}
      >
        Let them type it, rather than only accepting one carried in by the link.
      </CheckField>
      <Field
        label="What to say when asking for it"
        rows={2}
        value={draft.participant.text}
        onChange={(v) => edit((d) => ({ ...d, participant: { ...d.participant, text: v } }))}
      />

      <h3>The model</h3>
      <div className="protocol-grid">
        <Field label="Model" value={draft.model} onChange={(v) => edit((d) => ({ ...d, model: v }))} />
        <SelectField
          label="Provider"
          value={draft.myself.provider}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
            { value: "mock", label: "Mock (no calls)" },
          ]}
          onChange={(v) => my({ provider: v })}
        />
        <NumberField
          label="Temperature"
          value={draft.myself.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(v) => my({ temperature: v })}
        />
        <NumberField
          label="Longest reply (tokens)"
          value={draft.myself.max_output_tokens}
          min={1}
          onChange={(v) => my({ max_output_tokens: v })}
        />
      </div>
      <p className="dim">Extraction always runs at 0.1 whatever this says — it is the one stage that must not improvise.</p>

      <details className="protocol-more">
        <summary>Calls, regions and retention</summary>
        <div className="protocol-grid">
          <NumberField
            label="Timeout (seconds)"
            value={draft.myself.timeout_seconds}
            min={1}
            onChange={(v) => my({ timeout_seconds: v })}
          />
          <NumberField
            label="Attempts"
            value={draft.myself.max_attempts}
            min={1}
            max={5}
            onChange={(v) => my({ max_attempts: v })}
          />
          <Field
            label="Region"
            hint="Where the call is served from, if the provider lets you say."
            value={draft.myself.region ?? ""}
            onChange={(v) => my({ region: v || undefined })}
          />
          <Field
            label="Retention note"
            hint="What was agreed with the provider about keeping the text."
            value={draft.myself.retention_note ?? ""}
            onChange={(v) => my({ retention_note: v || undefined })}
          />
        </div>
        <CheckField checked={draft.myself.training_use_opt_out} onChange={(v) => my({ training_use_opt_out: v })}>
          Opt out of the provider training on what is sent. Leave this on for anything a child wrote.
        </CheckField>
        <SelectField
          label="With no connection"
          hint="What the module does when the model cannot be reached at all."
          value={draft.myself.offline_fallback}
          options={[
            { value: "continue_without_model", label: "Carry on without the model" },
            { value: "queue_authorised", label: "Queue the call for later" },
            { value: "predefined_fallback", label: "Use the fallback wording" },
            { value: "pause_module", label: "Pause the module" },
          ]}
          onChange={(v) => my({ offline_fallback: v })}
        />
      </details>

      <h3>Safety and data protection</h3>
      <Field
        label="Safeguarding declaration"
        hint={'Required before this can be fielded. "No automated rules; researcher review only" is a good answer.'}
        rows={4}
        value={draft.myself.safeguarding_declaration ?? ""}
        onChange={(v) => my({ safeguarding_declaration: v || undefined })}
      />
      <Field
        label="Variables allowed on screen"
        hint="Comma separated. A placeholder not listed here is left as written."
        value={draft.myself.permitted_variables.join(", ")}
        onChange={(v) => my({ permitted_variables: commas(v) })}
      />
      <Field
        label="Identifiers allowed into prompts"
        hint="Usually empty. Anything here is sent to the model provider, and the consent wording has to say so."
        value={draft.myself.permitted_identifiers.join(", ")}
        onChange={(v) => my({ permitted_identifiers: commas(v) })}
      />
      <ListField
        label="Consent requirements"
        hint="What the consent form must cover for this study. Checked at release time."
        values={draft.myself.consent_requirements}
        minimum={0}
        emptyNote="None recorded."
        addLabel="Add a requirement"
        onChange={(v) => my({ consent_requirements: v })}
      />

      <SafeguardingRules rules={draft.myself.safeguarding} onChange={(v) => my({ safeguarding: v })} />

      <details className="protocol-more">
        <summary>Typing-dynamics quality control</summary>
        <CheckField
          checked={draft.quality_control_flagging}
          onChange={(v) => edit((d) => ({ ...d, quality_control_flagging: v }))}
        >
          Switch it on. Aimed at crowdsourced adult panels. In a school a child who composes in Notes and pastes is not
          a bot — leave it off unless the sample is one where pasting means something.
        </CheckField>
        <div className="protocol-grid">
          <NumberField
            label="Characters a second"
            hint="Above this, a message is flagged as too fast to have been typed."
            value={draft.myself.max_chars_per_second}
            min={1}
            onChange={(v) => my({ max_chars_per_second: v })}
          />
          <NumberField
            label="Long message (characters)"
            value={draft.myself.long_message_chars}
            min={1}
            onChange={(v) => my({ long_message_chars: v })}
          />
          <NumberField
            label="Flag the run above"
            hint="Share of messages flagged, 0 to 1."
            value={draft.myself.flag_above_share}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => my({ flag_above_share: v })}
          />
        </div>
        <CheckField checked={draft.myself.stop_before_generation} onChange={(v) => my({ stop_before_generation: v })}>
          Stop before generating retellings when a run is flagged, rather than spending on one that will be discarded.
        </CheckField>
      </details>
    </div>
  );
}

/** The safeguarding rules: a lexicon or a classifier, a tier, and what is disclosed. */
function SafeguardingRules({ rules, onChange }: { rules: Rule[]; onChange: (v: Rule[]) => void }) {
  const patch = (index: number, change: Partial<Rule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...change } : r)));

  return (
    <div className="protocol-field">
      <span className="field-label">Safeguarding rules</span>
      <span className="dim">
        What is watched for, and what happens when it fires. A rule that notifies somebody has to say who, and what the
        participant is told.
      </span>
      {rules.length === 0 && <span className="dim">None. The declaration above still has to be filled in.</span>}
      {rules.map((rule, index) => (
        <div className="protocol-rule" key={index}>
          <div className="protocol-grid">
            <Field label="Key" value={rule.key} onChange={(v) => patch(index, { key: v })} />
            <SelectField
              label="Kind"
              value={rule.kind}
              options={[
                { value: "lexicon", label: "Word list" },
                { value: "model_classifier", label: "Model classifier" },
              ]}
              onChange={(v) => patch(index, { kind: v })}
            />
            <SelectField
              label="Tier"
              value={rule.tier}
              options={[
                { value: "data_quality", label: "Data quality" },
                { value: "team_notification", label: "Notify the team" },
                { value: "safeguarding_review", label: "Safeguarding review" },
              ]}
              onChange={(v) => patch(index, { tier: v })}
            />
          </div>
          <Field
            label="Terms"
            hint="Comma separated, for a word list."
            value={rule.terms.join(", ")}
            onChange={(v) => patch(index, { terms: v.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
          <Field
            label="Reviewers"
            hint="Comma separated. Who is told."
            value={rule.reviewers.join(", ")}
            onChange={(v) => patch(index, { reviewers: v.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
          <Field
            label="What the participant is told"
            rows={2}
            value={rule.disclosure}
            onChange={(v) => patch(index, { disclosure: v })}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            Remove this rule
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary small"
        onClick={() =>
          onChange([
            ...rules,
            { key: "", kind: "lexicon", terms: [], tier: "safeguarding_review", reviewers: [], disclosure: "" },
          ])
        }
      >
        Add a rule
      </button>
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
