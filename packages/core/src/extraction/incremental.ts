import type { NativeEvent } from '../native/session-reader.js';

/** Minimum new user turns before an extraction run is worth an LLM call. */
export const DEFAULT_MIN_NEW_USER_TURNS = 5;

/**
 * Events replayed from before the watermark to give the model context. A decision
 * often spans the boundary — the question is asked in one turn and settled in the
 * next — so a delta with no lead-in reads as a fragment.
 */
export const DEFAULT_OVERLAP_EVENTS = 4;

export interface IncrementalPlan {
  /** Whether this run should call the LLM at all. */
  shouldExtract: boolean;
  /** Populated when shouldExtract is false — safe to surface in telemetry. */
  skipReason?: string;
  /** The slice to feed the extractor, including replayed context. */
  events: NativeEvent[];
  /** Watermark to record after a successful run. */
  nextWatermark: number;
  /** User turns added since the last extraction. */
  newUserTurns: number;
}

export interface IncrementalOptions {
  minNewUserTurns?: number;
  overlapEvents?: number;
}

/**
 * Decide what to extract from a session given how much was extracted before.
 *
 * The Stop hook fires repeatedly within one session. Re-reading the full
 * transcript each time costs tokens to re-derive decisions that were already
 * recorded and then discarded as duplicates. This narrows each run to the turns
 * that are actually new.
 */
export function planIncrementalExtraction(
  events: NativeEvent[],
  watermark: number,
  opts: IncrementalOptions = {},
): IncrementalPlan {
  const minNewUserTurns = opts.minNewUserTurns ?? DEFAULT_MIN_NEW_USER_TURNS;
  const overlapEvents = opts.overlapEvents ?? DEFAULT_OVERLAP_EVENTS;

  // A watermark past the end means the transcript was rotated or truncated.
  // Treat the whole thing as unread rather than skipping the session forever.
  const safeWatermark = watermark > events.length ? 0 : Math.max(0, watermark);

  const newEvents = events.slice(safeWatermark);
  const newUserTurns = newEvents.filter((e) => e.type === 'user').length;

  if (newUserTurns < minNewUserTurns) {
    return {
      shouldExtract: false,
      skipReason: `Only ${newUserTurns} new user turn(s) since last extraction, need >= ${minNewUserTurns}`,
      events: [],
      nextWatermark: safeWatermark,
      newUserTurns,
    };
  }

  const contextStart = Math.max(0, safeWatermark - overlapEvents);

  return {
    shouldExtract: true,
    events: events.slice(contextStart),
    nextWatermark: events.length,
    newUserTurns,
  };
}
