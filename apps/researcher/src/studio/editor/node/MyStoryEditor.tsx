import { useCallback, useDeferredValue, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { NarrativeProtocol } from "@myself/narrative";
import { myStoryOf, protocolId, sameProtocol, setMyStory, updateSection, withProtocolVersion } from "@myself/studio";
import { downloadText } from "../../format.js";
import { Icon } from "../../ui/icons.js";
import { Button, InfoTip } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { Facts, IssueMessages, Panel, SwitchRow, TextField } from "./controls.js";
import { issuesAt, screenIssues, sectionIssues } from "./issues.js";
import {
  approvalWords,
  checkProtocolAsIs,
  checkProtocolFile,
  protocolChoices,
  protocolFilename,
  SURVEY_PROTOCOL,
  type ProtocolCheck,
  type ProtocolChoice,
} from "./mystory.js";
import { unlessUnchanged } from "./unchanged.js";

/**
 * MyStory: whether the survey ends with the MyStory conversation, and which
 * protocol it runs (docs/16 §10.1).
 *
 * It always comes last — participants finish the questions, then MyStory, then
 * the finish screen, and only then is the device handed back to the
 * researcher — so there is nothing here about where it goes. The protocol is
 * chosen from the built-in ones (or the survey's own), seen and edited as the
 * same TOML file the MyStory lab and the protocol editor use, checked as it is
 * typed, and frozen into the draft by "Use this protocol".
 */

const ABOUT =
  "A short conversation with an AI character at the end of the survey. It always comes last: participants finish the questions, then MyStory, then the finish screen, and only then is the device handed back.";

const FROZEN =
  "MyStory runs exactly this protocol. It is frozen into the version you publish, and the survey sends it to MyStory. Its key and version name it for good: an edited protocol needs a new version.";

export function MyStoryEditor() {
  const ctx = useEditor();
  const { draft } = ctx;
  const story = useMemo(() => myStoryOf(draft), [draft]);
  const issues = useMemo(() => screenIssues(ctx.issues, "mystory"), [ctx.issues]);
  // Its section's own checks (its title) are shown here too: MyStory's section is edited as MyStory.
  const own = useMemo(() => (story ? sectionIssues(ctx.issues, story.sectionKey) : null), [ctx.issues, story]);
  const readOnly = !ctx.canEdit;
  const section = story ? draft.composition.sections[story.sectionIndex] : undefined;
  const offline = draft.composition.offline.narrativeConnectivity;

  const choices = useMemo(() => protocolChoices(story), [story]);
  const [chosen, setChosen] = useState<string>(story ? SURVEY_PROTOCOL : (choices[0]?.value ?? ""));
  const choice = choices.find((c) => c.value === chosen) ?? choices[0]!;
  const validateTitle = useCallback((text: string) => (text.trim() ? null : "MyStory's section needs a title: participants see it in the progress bar."), []);

  const switchTo = (on: boolean) => {
    if (on) {
      const ok = ctx.run("Switch MyStory on", (d) => setMyStory(d, choice.protocol).draft);
      if (ok) {
        setChosen(SURVEY_PROTOCOL);
        ctx.announce(`MyStory is on, running ${protocolId(choice.protocol)}. It comes last in the survey.`);
      }
    } else if (ctx.run("Switch MyStory off", (d) => setMyStory(d, null).draft)) {
      ctx.announce("MyStory is off. The survey ends with its finish screen.");
    }
  };

  return (
    <div className="stn-node stn-mystory">
      <header className="stn-pagehead">
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          MyStory
        </h2>
        <p className="stn-lead">
          {story ? "On, at the end of the survey." : "Off: the survey ends with its finish screen."}
          <InfoTip text={ABOUT} label="MyStory" />
        </p>
      </header>
      <IssueMessages issues={[...issues.general, ...(own?.general ?? [])]} />

      <Panel title="In this survey" field="placement">
        <SwitchRow
          label="End the survey with MyStory"
          field="mystory"
          checked={!!story}
          disabled={readOnly}
          onChange={switchTo}
          info="On, MyStory is the survey's last part, after every question and before the finish screen. Off, it is taken out, with its protocol; nothing else in the survey changes."
        />
        <IssueMessages issues={issuesAt(issues, "placement")} />
        {story && section ? (
          <>
            <TextField
              label="Title in the progress bar"
              field="title"
              value={section.title}
              readOnly={readOnly}
              lockedReason={ctx.readOnlyReason}
              validate={validateTitle}
              issues={own?.byField.get("title")}
              onCommit={(title) =>
                ctx.run("Rename MyStory's section", (d) =>
                  unlessUnchanged(d, updateSection(d, story.sectionKey, { title }).draft, (x) => x.composition.sections.find((s) => s.key === story.sectionKey)?.title),
                )
              }
            />
            <Facts
              rows={[
                { label: "Protocol", value: story.definition?.name ?? "Not carried by the draft" },
                { label: "Key and version", value: <code>{story.id}</code> },
                { label: "Approval", value: approvalWords(story.definition?.approvalStatus) },
                {
                  label: "Connection",
                  value: offline === "offline_capable_with_queue" ? "Waits for a connection when offline" : "Needs a connection",
                  info: "Its conversation is with a model, so it needs the network. The rest of the survey works offline either way.",
                },
              ]}
            />
          </>
        ) : null}
      </Panel>

      <Panel title="Protocol" field="protocol" info={FROZEN}>
        <IssueMessages issues={issuesAt(issues, "protocol")} />
        <ProtocolChooser choices={choices} value={choice.value} onChange={setChosen} />
        {/* Remounted when what is chosen changes, so the file shown is that protocol's. */}
        <ProtocolFile key={`${choice.value}\u0000${choice.toml ?? protocolId(choice.protocol)}`} choice={choice} storyOn={!!story} onUsed={() => setChosen(SURVEY_PROTOCOL)} />
      </Panel>
    </div>
  );
}

function ProtocolChooser({ choices, value, onChange }: { choices: ProtocolChoice[]; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="st-field">
      <label htmlFor={id} className="st-field-label">
        Start from
      </label>
      <select id={id} className="st-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The chosen protocol as its file: edited in place, checked on every
 * keystroke, and frozen into the draft only by "Use this protocol".
 */
function ProtocolFile({ choice, storyOn, onUsed }: { choice: ProtocolChoice; storyOn: boolean; onUsed: () => void }) {
  const ctx = useEditor();
  const readOnly = !ctx.canEdit;
  const published = ctx.published?.publishedProtocols;
  const story = useMemo(() => myStoryOf(ctx.draft), [ctx.draft]);
  const [text, setText] = useState(choice.toml ?? "");
  const typed = useDeferredValue(text);
  const check: ProtocolCheck = useMemo(
    () => (choice.toml === null ? checkProtocolAsIs(choice.protocol, published) : checkProtocolFile(typed, published)),
    [choice, typed, published],
  );
  const fileId = useId();
  const statusId = `${fileId}-status`;
  const upload = useRef<HTMLInputElement | null>(null);
  const edited = choice.toml !== null && text !== choice.toml;
  const inUse = !!story?.definition && !!check.protocol && sameProtocol(story.definition, check.protocol);

  const use = (protocol: NarrativeProtocol) => {
    const id = protocolId(protocol);
    if (ctx.run(storyOn ? `Use ${id} for MyStory` : `Switch MyStory on with ${id}`, (d) => setMyStory(d, protocol).draft)) {
      ctx.announce(`MyStory now runs ${id}.`);
      onUsed();
    }
  };

  const open = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void file.text().then(setText);
  };

  return (
    <>
      {choice.toml === null ? (
        <p className="stn-inline-note">
          <Icon name="info" size={14} />
          This protocol has stages a protocol file can&rsquo;t express, so it is used as it is.
        </p>
      ) : (
        <div className="st-field">
          <label htmlFor={fileId} className="st-field-label">
            Protocol file (TOML)
          </label>
          <textarea
            id={fileId}
            className="st-input stn-mono stn-toml"
            data-field="protocol.file"
            value={text}
            rows={18}
            spellCheck={false}
            readOnly={readOnly}
            aria-describedby={statusId}
            aria-invalid={check.problems.length > 0 || undefined}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      <div id={statusId} className="stn-msgs" aria-live="polite">
        {check.problems.length > 0 ? (
          <>
            <p className="stn-msg stn-msg-error">
              <Icon name="error" size={14} />
              <span>
                <span className="st-sr">Error: </span>
                {check.protocol ? "It reads as a protocol, but can't be used yet:" : "It doesn't read as a protocol yet:"}
              </span>
            </p>
            <ul className="stn-problems">
              {check.problems.map((p, i) => (
                <li key={`${i}:${p}`}>{p}</li>
              ))}
            </ul>
          </>
        ) : check.clash ? (
          <p className="stn-msg">
            <Icon name="warning" size={14} />
            <span>
              <span className="st-sr">Warning: </span>
              {check.clash.where === "published"
                ? `${protocolId(check.protocol!)} was published with different content.`
                : `${protocolId(check.protocol!)} is a built-in protocol, and this differs from it.`}{" "}
              Give it a new version, such as {check.clash.next}.
            </span>
          </p>
        ) : check.protocol && !check.approved ? (
          <p className="stn-msg">
            <Icon name="warning" size={14} />
            <span>
              <span className="st-sr">Warning: </span>
              {approvalWords(check.protocol.approvalStatus)}. It can be tried in the preview, but not published until its file says
              approval_status = &quot;approved&quot;.
            </span>
          </p>
        ) : check.protocol ? (
          <p className="stn-inline-note">
            <Icon name="check" size={14} />
            {protocolId(check.protocol)} reads as a protocol and passes its checks.
          </p>
        ) : null}
      </div>

      <div className="stn-actionrow">
        <span className="stn-row-actions">
          {check.clash && choice.toml !== null && !readOnly ? (
            <Button size="sm" variant="secondary" onClick={() => setText((t) => withProtocolVersion(t, check.clash!.next))}>
              Use version {check.clash.next}
            </Button>
          ) : null}
          {edited && !readOnly ? (
            <Button size="sm" variant="ghost" onClick={() => setText(choice.toml ?? "")}>
              Undo edits to the file
            </Button>
          ) : null}
        </span>
        <span className="stn-row-actions">
          {choice.toml !== null ? (
            <>
              <input ref={upload} type="file" accept=".toml,text/plain" hidden onChange={open} />
              <Button size="sm" variant="ghost" icon="import" disabled={readOnly} onClick={() => upload.current?.click()}>
                Open a file
              </Button>
              <Button size="sm" variant="ghost" icon="arrow-down" onClick={() => downloadText(text, protocolFilename(check.protocol), "application/toml")}>
                Download
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={readOnly || !check.protocol || check.problems.length > 0 || (storyOn && inUse)}
            onClick={() => check.protocol && use(check.protocol)}
          >
            {storyOn && inUse ? "In use" : storyOn ? "Use this protocol" : "Switch on with this protocol"}
          </Button>
        </span>
      </div>
    </>
  );
}
