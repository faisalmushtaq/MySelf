import type { QualityControlConfig } from "./protocol.js";

/**
 * Typing-dynamics quality signals, carried over from the original app.
 *
 * The audited implementation smuggles a typing trace through zero-width
 * characters in the chat input, and derives per-message signals from it: was
 * this pasted, was it typed implausibly fast, is it long or multi-line in a
 * way a real answer rarely is. If more than a threshold share of messages trip
 * any signal, the session stops before anything is generated. §8.2 records it
 * as genuinely novel and scientifically load-bearing for crowdsourced adult
 * samples, so it is kept.
 *
 * Two things are different here, both deliberate.
 *
 * It is OFF by default. In a crowdsourced panel a pasted answer is probably a
 * bot; in a school hall, a child who composes in Notes and pastes, or who
 * types very fast, or who is using a keyboard for the first time, is just a
 * child. Treating them as suspect would be both wrong and invisible to them.
 *
 * And it never discards. The original stops before generation, which is right
 * — there is no point paying for retellings of pasted text — but everything
 * collected is still saved, and the flag is a note for a human, not a verdict.
 */

export interface MessageTrace {
  /** What was typed or pasted. */
  text: string;
  /** Milliseconds from the message being requested to it being sent. */
  composeMs: number;
  /** Whether a paste was detected while composing. */
  pasted: boolean;
}

export interface MessageSignals {
  pasted: boolean;
  fastTyping: boolean;
  longOrMultiline: boolean;
  charsPerSecond: number | null;
  /** Any signal at all — what the aggregate share is computed over. */
  suspect: boolean;
}

export function signalsFor(trace: MessageTrace, config: QualityControlConfig): MessageSignals {
  const chars = trace.text.length;
  // A message composed in under a tenth of a second gives a meaningless rate;
  // it is the paste flag's job to catch that, not arithmetic on a divide by
  // almost-zero.
  const seconds = trace.composeMs / 1000;
  const charsPerSecond = seconds >= 0.1 ? chars / seconds : null;

  const fastTyping = charsPerSecond !== null && charsPerSecond > config.maxCharsPerSecond;
  const longOrMultiline = chars > config.longMessageChars || /\n/.test(trace.text.trim());

  return {
    pasted: trace.pasted,
    fastTyping,
    longOrMultiline,
    charsPerSecond,
    suspect: trace.pasted || fastTyping || longOrMultiline,
  };
}

export interface QualityAggregate {
  messages: number;
  suspectMessages: number;
  suspectShare: number;
  pasteMessageRatio: number;
  fastTypingRatio: number;
  longOrMultilineRatio: number;
  /** Whether the session crosses the researcher's threshold. */
  flagged: boolean;
}

export function aggregate(signals: MessageSignals[], config: QualityControlConfig): QualityAggregate {
  const messages = signals.length;
  const share = (predicate: (s: MessageSignals) => boolean) =>
    messages === 0 ? 0 : signals.filter(predicate).length / messages;

  const suspectShare = share((s) => s.suspect);
  return {
    messages,
    suspectMessages: signals.filter((s) => s.suspect).length,
    suspectShare,
    pasteMessageRatio: share((s) => s.pasted),
    fastTypingRatio: share((s) => s.fastTyping),
    longOrMultilineRatio: share((s) => s.longOrMultiline),
    // Strictly above: a threshold of 0.3 means "more than 30%", so exactly
    // three in ten is not flagged. Where a study sets 0, any suspect message
    // flags — which is what setting zero means.
    flagged:
      config.enabled &&
      messages > 0 &&
      (config.flagAboveShare === 0 ? suspectShare > 0 : suspectShare > config.flagAboveShare),
  };
}

/** Whether generation should be held back, given the aggregate. */
export const shouldStopBeforeGeneration = (result: QualityAggregate, config: QualityControlConfig): boolean =>
  config.enabled && config.stopBeforeGeneration && result.flagged;
