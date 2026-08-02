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

export interface FlattenedRelease {
  units: PresentableUnit[];
  /** Section key -> participant-facing transition text. */
  transitions: Map<string, string>;
  sectionTitles: Map<string, string>;
}

export function flattenManifest(manifest: ReleaseManifest): FlattenedRelease {
  const units: PresentableUnit[] = [];
  const transitions = new Map<string, string>();
  const sectionTitles = new Map<string, string>();

  const byRef = new Map<string, FrozenInstrument>();
  for (const [refKey, def] of Object.entries(manifest.instruments)) {
    byRef.set(refKey, def as FrozenInstrument);
  }

  for (const section of manifest.composition.sections) {
    sectionTitles.set(section.key, section.title);
    if (section.transition) transitions.set(section.key, section.transition);

    for (const component of section.components) {
      if (component.kind !== "instrument" && component.kind !== "module") continue;
      const ref = component.ref;
      const refKey = `${ref.instrument}@${ref.version}${ref.variant ? `+${ref.variant}` : ""}/${ref.language}/${ref.informant}/${ref.readingLevel}`;
      const frozen = byRef.get(refKey);
      if (!frozen) throw new Error(`manifest inconsistency: '${refKey}' not frozen`);
      const form = frozen.forms[0];
      if (!form) throw new Error(`manifest inconsistency: '${refKey}' has no form`);

      const componentCondition = and(section.displayIf, component.displayIf);
      let instructionsEmitted = false;
      for (const item of form.items) {
        // Instrument instructions become an info unit before the first item,
        // preserving validated administration text verbatim (docs/07 §3).
        if (!instructionsEmitted && form.instructions) {
          const instructionItem: ItemDefinition = {
            responseType: "info",
            key: `__instructions_${ref.instrument}`,
            revision: 1,
            variable: `meta_instr_${ref.instrument.slice(0, 20)}`,
            stem: { text: form.instructions },
            required: "optional",
            allowDecline: false,
          };
          units.push({
            instrument: ref.instrument,
            sectionKey: section.key,
            item: instructionItem,
            displayIf: componentCondition,
          });
          instructionsEmitted = true;
        }
        units.push({
          instrument: ref.instrument,
          sectionKey: section.key,
          item,
          displayIf: and(componentCondition, item.displayIf),
        });
      }
    }
  }

  return { units, transitions, sectionTitles };
}
