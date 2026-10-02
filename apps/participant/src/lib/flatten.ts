import type { PresentableUnit } from "@myself/engine";
import type { InstrumentForm, ItemDefinition, LogicExpr, ReleaseManifest } from "@myself/schema";

/**
 * Flatten a frozen release manifest into the engine's ordered PresentableUnit
 * list. Display conditions conjoin section-level and item-level logic. Each
 * frozen instrument entry contains exactly the one administered form.
 */

interface FrozenInstrument {
  instrument: string;
  forms: InstrumentForm[];
}

const and = (a: LogicExpr | undefined, b: LogicExpr | undefined): LogicExpr | undefined => {
  if (a && b) return { op: "all", args: [a, b] };
  return a ?? b;
};

/**
 * The reminder shown when someone asks "what is this about again?" mid-battery.
 *
 * Instrument instructions open by describing what is coming ("the next few
 * screens each show a statement…"), which is exactly wrong as a reminder: by
 * then the statement is already on screen. The useful part is the last
 * sentence, which says how to answer. Take that.
 */
export function reminderOf(instructions: string): string {
  const sentences = instructions
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences[sentences.length - 1] ?? instructions;
}

/**
 * The questions a placement lists, looked up by key. A key the form does not
 * have is a manifest inconsistency — the publish gate refuses one — so it
 * throws, like the other inconsistencies here, rather than silently dropping a
 * question from every sitting.
 */
function pick(form: InstrumentForm, keys: string[], refKey: string): ItemDefinition[] {
  const byKey = new Map(form.items.map((i) => [i.key, i]));
  return keys.map((key) => {
    const item = byKey.get(key);
    if (!item) throw new Error(`manifest inconsistency: '${refKey}' has no question '${key}'`);
    return item;
  });
}

export interface FlattenedRelease {
  units: PresentableUnit[];
  /** Unit index -> the instrument instructions that framed it, so a
   * participant who has forgotten the context can ask for it again. */
  context: Map<number, string>;
  /** Section key -> participant-facing transition text. */
  transitions: Map<string, string>;
  sectionTitles: Map<string, string>;
}

export function flattenManifest(manifest: ReleaseManifest): FlattenedRelease {
  const units: PresentableUnit[] = [];
  const context = new Map<number, string>();
  const transitions = new Map<string, string>();
  const sectionTitles = new Map<string, string>();

  const placements = new Map<string, number>();
  const byRef = new Map<string, FrozenInstrument>();
  for (const [refKey, def] of Object.entries(manifest.instruments)) {
    byRef.set(refKey, def as FrozenInstrument);
  }

  for (const section of manifest.composition.sections) {
    sectionTitles.set(section.key, section.title);
    if (section.transition) transitions.set(section.key, section.transition);

    for (const component of section.components) {
      if (component.kind === "narrative") {
        // A narrative is one position in the walk, like a question. It carries
        // a marker item so conditions, ordering, back navigation and timing
        // need no special case; the survey screen checks `narrative` and hands
        // over to the module instead of drawing a question.
        const protocol = manifest.narrativeProtocols[`${component.protocol}@${component.protocolVersion}`];
        if (!protocol) {
          throw new Error(
            `manifest inconsistency: section '${section.key}' places '${component.protocol}@${component.protocolVersion}', which is not frozen into this release`,
          );
        }
        units.push({
          instrument: component.protocol,
          sectionKey: section.key,
          narrative: { protocol: component.protocol, version: component.protocolVersion },
          displayIf: and(section.displayIf, component.displayIf),
          item: {
            responseType: "info",
            key: `__narrative_${component.protocol.replace(/^np\./, "")}`,
            revision: 1,
            variable: `meta_narr_${component.protocol.replace(/^np\./, "").slice(0, 20)}`,
            stem: { text: "" },
            required: "optional",
            allowDecline: false,
            identifying: false,
          },
        });
        continue;
      }
      if (component.kind !== "instrument" && component.kind !== "module") continue;
      const ref = component.ref;
      const refKey = `${ref.instrument}@${ref.version}${ref.variant ? `+${ref.variant}` : ""}/${ref.language}/${ref.informant}/${ref.readingLevel}`;
      const frozen = byRef.get(refKey);
      if (!frozen) throw new Error(`manifest inconsistency: '${refKey}' not frozen`);
      const form = frozen.forms[0];
      if (!form) throw new Error(`manifest inconsistency: '${refKey}' has no form`);

      const componentCondition = and(section.displayIf, component.displayIf);
      // A placement may show only some of the form's questions, in its own
      // order (D-49). Absent, it is the whole form — every release to r7.1.0.
      const items = component.items ? pick(form, component.items, refKey) : form.items;
      // The same instrument can be placed more than once when its questions
      // are split across sections. The first placement keeps the key every
      // earlier release used; later ones are numbered, so no two units share one.
      const placement = (placements.get(ref.instrument) ?? 0) + 1;
      placements.set(ref.instrument, placement);
      let instructionsEmitted = false;
      for (const item of items) {
        // Instrument instructions become an info unit before the first item,
        // preserving validated administration text verbatim (docs/07 §3).
        if (!instructionsEmitted && form.instructions) {
          const instructionItem: ItemDefinition = {
            responseType: "info",
            key: placement === 1 ? `__instructions_${ref.instrument}` : `__instructions_${ref.instrument}_${placement}`,
            revision: 1,
            variable: `meta_instr_${ref.instrument.slice(0, 20)}`,
            stem: { text: form.instructions },
            required: "optional",
            allowDecline: false,
            // Administration text, not a participant answer — nothing here can
            // identify anyone, so it never diverts to the identity partition.
            identifying: false,
          };
          units.push({
            instrument: ref.instrument,
            sectionKey: section.key,
            item: instructionItem,
            displayIf: componentCondition,
          });
          instructionsEmitted = true;
        }
        if (form.instructions) context.set(units.length, reminderOf(form.instructions));
        units.push({
          instrument: ref.instrument,
          sectionKey: section.key,
          item,
          displayIf: and(componentCondition, item.displayIf),
        });
      }
    }
  }

  return { units, context, transitions, sectionTitles };
}
