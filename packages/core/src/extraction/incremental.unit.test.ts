import { describe, it, expect } from 'vitest';
import { planIncrementalExtraction } from './incremental.js';
import type { NativeEvent } from '../native/session-reader.js';

/** Build an alternating user/assistant transcript of `turns` exchanges. */
function transcript(turns: number): NativeEvent[] {
  const events: NativeEvent[] = [];
  for (let i = 0; i < turns; i++) {
    events.push({ uuid: `u${i}`, timestamp: '', type: 'user', text: `ask ${i}` });
    events.push({ uuid: `a${i}`, timestamp: '', type: 'assistant', text: `answer ${i}` });
  }
  return events;
}

describe('planIncrementalExtraction', () => {
  it('skips a session that has not reached the turn threshold', () => {
    const plan = planIncrementalExtraction(transcript(3), 0);
    expect(plan.shouldExtract).toBe(false);
    expect(plan.newUserTurns).toBe(3);
    expect(plan.skipReason).toContain('3 new user turn');
    expect(plan.nextWatermark).toBe(0);
  });

  it('extracts once the threshold is reached', () => {
    const events = transcript(5);
    const plan = planIncrementalExtraction(events, 0);
    expect(plan.shouldExtract).toBe(true);
    expect(plan.newUserTurns).toBe(5);
    expect(plan.nextWatermark).toBe(events.length);
  });

  it('only counts turns added since the watermark', () => {
    const events = transcript(12); // 24 events, 12 user turns
    // Already extracted through event 20 -> 2 user turns remain.
    const plan = planIncrementalExtraction(events, 20);
    expect(plan.shouldExtract).toBe(false);
    expect(plan.newUserTurns).toBe(2);
  });

  it('feeds only the new turns plus a small replayed context window', () => {
    const events = transcript(20); // 40 events
    const plan = planIncrementalExtraction(events, 30, { overlapEvents: 4 });
    expect(plan.shouldExtract).toBe(true);
    // 10 new events + 4 replayed = 14, not the full 40.
    expect(plan.events).toHaveLength(14);
    expect(plan.events[0]?.uuid).toBe('u13'); // index 26
    expect(plan.events.length).toBeLessThan(events.length);
  });

  it('does not read before the start of the transcript', () => {
    // Watermark 1 leaves 5 new user turns in a 6-exchange transcript, so this
    // extracts; the oversized overlap must clamp to index 0, not go negative.
    const events = transcript(6);
    const plan = planIncrementalExtraction(events, 1, { overlapEvents: 10 });
    expect(plan.shouldExtract).toBe(true);
    expect(plan.events).toHaveLength(events.length);
    expect(plan.events[0]?.uuid).toBe('u0');
  });

  it('re-reads from the start when the watermark is beyond the transcript', () => {
    // A rotated or truncated transcript must not disable extraction forever.
    const events = transcript(6);
    const plan = planIncrementalExtraction(events, 999);
    expect(plan.shouldExtract).toBe(true);
    expect(plan.events).toHaveLength(events.length);
    expect(plan.nextWatermark).toBe(events.length);
  });

  it('treats a negative watermark as the start', () => {
    const events = transcript(5);
    expect(planIncrementalExtraction(events, -5).events).toHaveLength(events.length);
  });

  it('never extracts an empty transcript', () => {
    const plan = planIncrementalExtraction([], 0);
    expect(plan.shouldExtract).toBe(false);
    expect(plan.events).toEqual([]);
  });

  it('advances the watermark so the same turns are not extracted twice', () => {
    const events = transcript(6);
    const first = planIncrementalExtraction(events, 0);
    expect(first.shouldExtract).toBe(true);

    // Second Stop with no new activity.
    const second = planIncrementalExtraction(events, first.nextWatermark);
    expect(second.shouldExtract).toBe(false);
    expect(second.newUserTurns).toBe(0);
  });
});
