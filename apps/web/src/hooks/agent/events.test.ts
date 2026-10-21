import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  newRunEvents,
  parseAnalysisEvent,
  parseFactoidEvent,
  resetSkippedReports,
  streamGuard,
} from './events';

const json = (event: object) => JSON.stringify(event);
const status = (seq: number, runId = 'run-1') => ({
  type: 'status',
  runId,
  seq,
  message: `step ${seq}`,
});
const result = {
  id: 't',
  title: 'Hurt',
  artist: 'NIN',
  album: 'A',
  coverUrl: '',
  bpm: null,
  genealogy: { nodes: [], links: [] },
};
const complete = (seq: number, runId = 'run-1') => ({ type: 'complete', runId, seq, data: result });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetSkippedReports();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('parseAnalysisEvent', () => {
  it('returns an event that fits the contract as it was sent', () => {
    const event = { ...complete(3), data: { ...result, audioSource: 'estimated' } };
    expect(parseAnalysisEvent(json(event))).toEqual(event);
    expect(parseAnalysisEvent(json({ type: 'heartbeat', runId: 'run-1' }))).toEqual({
      type: 'heartbeat',
      runId: 'run-1',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown type', { type: 'candidates', runId: 'run-1', seq: 2, candidates: [] }],
    ['no run id', { type: 'status', seq: 0, message: 'x' }],
    ['no seq', { type: 'status', runId: 'run-1', message: 'x' }],
    ['a negative seq', status(-1)],
    ['an error without a code', { type: 'error', runId: 'run-1', seq: 0, error: 'x' }],
    ['an interrupt without candidates', { type: 'interrupt', runId: 'r', seq: 0, threadId: 'r' }],
    ['a result that is not a TrackAnalysis', { ...complete(1), data: { title: 'x' } }],
  ])('skips an event with %s', (_what, event) => {
    expect(parseAnalysisEvent(json(event))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips a message that is not JSON', () => {
    expect(parseAnalysisEvent('{not json')).toBeNull();
  });

  it('logs each kind of skipped message once', () => {
    for (let i = 0; i < 3; i++) parseAnalysisEvent(json({ type: 'mystery', runId: 'r', seq: i }));
    parseAnalysisEvent(json({ type: 'status', runId: 'r', seq: 4 }));
    parseAnalysisEvent(json({ type: 'status', runId: 'r', seq: 5 }));

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('parseFactoidEvent', () => {
  it('reads factoid events with or without a run id, and skips a removed factoid type', () => {
    const factoid = { id: 'f1', title: 'T', content: 'C', type: 'sample' };
    expect(
      parseFactoidEvent(json({ type: 'factoid', runId: null, seq: 1, data: factoid })),
    ).not.toBeNull();
    expect(
      parseFactoidEvent(json({ type: 'error', runId: 'run-1', seq: 2, code: 'x', error: 'y' })),
    ).not.toBeNull();
    expect(
      parseFactoidEvent(
        json({ type: 'factoid', runId: null, seq: 3, data: { ...factoid, type: 'lyrics' } }),
      ),
    ).toBeNull();
  });
});

describe('streamGuard', () => {
  it('passes events in order and drops repeats and events that arrive out of order', () => {
    const accept = streamGuard(newRunEvents());
    expect([0, 1, 1, 3, 2, 4].map((seq) => accept(status(seq)))).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('passes heartbeats, which carry no seq', () => {
    const accept = streamGuard(newRunEvents());
    accept(status(4));
    expect(accept({ type: 'heartbeat', runId: 'run-1' })).toBe(true);
    expect(accept({ type: 'heartbeat', runId: 'run-0' })).toBe(false);
  });

  it("takes the run id from the run's first event and drops events of another run", () => {
    const run = newRunEvents();
    const accept = streamGuard(run);
    expect(accept(status(0, 'run-2'))).toBe(true);
    expect(run.runId).toBe('run-2');
    expect(accept(status(1, 'run-1'))).toBe(false);
    expect(accept(complete(2, 'run-1'))).toBe(false);
    expect(run.completed).toBe(false);
  });

  it('takes one complete per run, across the streams of the run', () => {
    const run = newRunEvents();
    const analysis = streamGuard(run);
    const resume = streamGuard(run);
    expect(analysis(status(0))).toBe(true);
    // The resume stream numbers from 0 again.
    expect(resume(status(0))).toBe(true);
    expect(resume(complete(1))).toBe(true);
    expect(resume(complete(2))).toBe(false);
    expect(analysis(complete(1))).toBe(false);
  });

  it('matches any run for a factoid stream that does not know its run', () => {
    const accept = streamGuard(newRunEvents());
    expect(accept({ type: 'factoid', runId: null, seq: 0 })).toBe(true);
    expect(accept({ type: 'factoid', runId: null, seq: 0 })).toBe(false);
    expect(accept({ type: 'factoid', runId: null, seq: 1 })).toBe(true);
  });
});
