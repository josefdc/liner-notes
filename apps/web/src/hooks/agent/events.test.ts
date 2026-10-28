import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eventSchemasLoaded,
  loadEventSchemas,
  newRunEvents,
  parseAnalysisEvent,
  parseFactoidEvent,
  resetSkippedReports,
  streamGuard,
} from './events';
import { audioBlock } from '../../components/measured/testing';

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
// The first import of the schemas (zod and the contract) is transformed cold, which on a busy
// machine can take far longer than the 10 s a hook gets by default; nothing here is timed.
beforeAll(async () => {
  expect(eventSchemasLoaded()).toBe(false);
  await loadEventSchemas();
  expect(eventSchemasLoaded()).toBe(true);
}, 120_000);
beforeEach(() => {
  resetSkippedReports();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the measurement of a result', () => {
  const withAudio = (audio: unknown, change: object = {}) => ({
    ...complete(3),
    data: { ...result, ...change, audio },
  });
  const audioOf = (event: object) =>
    (parseAnalysisEvent(json(event)) as { data: { audio?: unknown } }).data.audio;

  it('reaches the app as the contract reads it', () => {
    const block = audioBlock();
    expect(audioOf(withAudio(block))).toEqual(block);
  });

  it.each([
    [
      'a malformed section',
      audioBlock({ sections: { segments: 'A', method: 'x', basis: 'signal' } }),
    ],
    [
      'a model without a licence',
      audioBlock({
        fingerprint: {
          ...audioBlock().fingerprint,
          styles: { model: { id: 'm' }, top: [], basis: 'model' },
        },
      }),
    ],
    ['an unknown gate reason', audioBlock({ gate: { passed: false, reason: 'clipping' } })],
    ['another version', audioBlock({ version: 3 })],
  ])('is null when the contract cannot read it (%s)', (_case, block) => {
    expect(audioOf(withAudio(block))).toBeNull();
  });

  it('is null in a result read leniently, when the contract cannot read it', () => {
    // A genealogy that is not an object makes the result itself not fit the contract.
    const event = withAudio(audioBlock({ version: 3 }), { genealogy: 'none' });
    expect(audioOf(event)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('(complete): does not fit the contract; read leniently'),
      expect.anything(),
    );
    expect(audioOf(withAudio(audioBlock(), { genealogy: 'none' }))).toEqual(audioBlock());
  });

  it('stays absent from a result without one', () => {
    expect('audio' in (parseAnalysisEvent(json(complete(3))) as { data: object }).data).toBe(false);
  });
});

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
    [
      'an audio reason this page does not know',
      {
        type: 'audio',
        runId: 'run-1',
        seq: 3,
        audio: null,
        unavailableReason: 'reason-from-a-newer-api',
      },
    ],
  ])('skips an event with %s', (_what, event) => {
    expect(parseAnalysisEvent(json(event))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // What the contract calls additive (a new enum value, a wider type, a looser bound) must not
  // cost the user the result: the outcome is read by its envelope and handed to the app.
  it.each([
    ['a new run mode', { run: { id: 'r', mode: 'replay-v2', fallback: false } }],
    ['a null preview URL', { previewUrl: null }],
    ['no bpm', { bpm: undefined }],
    ['credits without writers', { credits: { producers: ['X'] } }],
  ])('uses a result with %s, logged once', (_what, change) => {
    const event = { ...complete(3), data: { ...result, ...change } };
    expect(parseAnalysisEvent(json(event))).toEqual(JSON.parse(json(event)));
    parseAnalysisEvent(json(event));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      '(complete): does not fit the contract; read leniently',
    );
  });

  it("keeps a leniently read outcome's time since the run started, and drops one that is not a time", () => {
    const loose = { run: { id: 'r', mode: 'replay-v2', fallback: false } };
    const timed = { ...complete(3), elapsedMs: 20_167, data: { ...result, ...loose } };
    expect(parseAnalysisEvent(json(timed))).toMatchObject({ type: 'complete', elapsedMs: 20_167 });
    const odd = { ...complete(4), elapsedMs: -1, data: { ...result, ...loose } };
    expect(parseAnalysisEvent(json(odd))).not.toHaveProperty('elapsedMs');
  });

  it('uses an interrupt with a candidate this page cannot fully read, and keeps what it can', () => {
    const candidate = { id: 'c1', title: 'Hurt', artist: 'NIN', album: 'A', coverUrl: '' };
    const event = {
      type: 'interrupt',
      runId: 'run-1',
      seq: 2,
      reason: 'disambiguation-v2',
      threadId: 'run-1',
      message: 'Pick one',
      candidates: [
        { ...candidate, coverUrl: null, popularity: 120 },
        { ...candidate, id: 'c2', releaseYear: '1994' },
        { title: 'No id' },
      ],
    };
    expect(parseAnalysisEvent(json(event))).toEqual({
      ...event,
      // Three were sent; the one without an id cannot be read.
      sentCount: 3,
      // A wider bound is kept as sent; a field of the wrong type reads as missing.
      candidates: [
        { ...candidate, popularity: 120 },
        { ...candidate, id: 'c2', releaseYear: '1994' },
      ],
    });
  });

  it("keeps a candidate's ISRC, release date, explicit flag and length, by which the picker merges rows", () => {
    const candidate = { id: 'c1', title: 'Hurt', artist: 'NIN', album: 'A', coverUrl: '' };
    const event = {
      type: 'interrupt',
      runId: 'run-1',
      seq: 2,
      reason: 'disambiguation',
      threadId: 'run-1',
      message: 'Pick one',
      candidates: [
        {
          ...candidate,
          isrc: 'USIR19400001',
          releaseDate: '1994-03-08',
          explicit: true,
          durationMs: 218_000,
        },
        { ...candidate, id: 'c2', isrc: null, releaseDate: null, explicit: null },
        { ...candidate, id: 'c3', isrc: 7, releaseDate: 1994, explicit: 'yes', durationMs: '218' },
      ],
    };
    expect(parseAnalysisEvent(json(event))).toEqual({
      ...event,
      sentCount: 3,
      candidates: [
        {
          ...candidate,
          isrc: 'USIR19400001',
          releaseDate: '1994-03-08',
          explicit: true,
          durationMs: 218_000,
        },
        { ...candidate, id: 'c2' },
        { ...candidate, id: 'c3' },
      ],
    });
  });

  it.each([
    ['a result that is not an object', { ...complete(1), data: 'Hurt' }],
    ['a result without a seq', { type: 'complete', runId: 'run-1', data: result }],
    ['an interrupt without candidates', { type: 'interrupt', runId: 'r', seq: 0, threadId: 'r' }],
    [
      'an interrupt whose candidates cannot be shown',
      { type: 'interrupt', runId: 'r', seq: 0, threadId: 'r', candidates: [{ id: 'c1' }] },
    ],
  ])('marks an outcome with %s as unreadable', (_what, event) => {
    expect(parseAnalysisEvent(json(event))).toMatchObject({
      type: 'unreadable',
      event: event.type,
      runId: event.runId,
    });
    expect(warn.mock.calls[0][0]).toContain('cannot be read');
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

  it('takes a refusal (error at seq 0, then done) under a run id of its own', () => {
    const run = newRunEvents();
    run.runId = 'run-1';
    const resume = streamGuard(run);
    const refusal = { type: 'error', runId: 'fresh-id', seq: 0 };
    expect(resume(refusal)).toBe(true);
    expect(resume({ type: 'done', runId: 'fresh-id', seq: 1 })).toBe(true);
    expect(run.runId).toBe('run-1');

    // Anything else of another run is still dropped.
    const other = streamGuard(run);
    expect(other(status(0))).toBe(true);
    expect(other({ ...refusal, seq: 1 })).toBe(false);
    expect(streamGuard(run)({ type: 'done', runId: 'fresh-id', seq: 1 })).toBe(false);
    expect(streamGuard(run)(complete(0, 'fresh-id'))).toBe(false);
  });

  it('matches any run for a factoid stream that does not know its run', () => {
    const accept = streamGuard(newRunEvents());
    expect(accept({ type: 'factoid', runId: null, seq: 0 })).toBe(true);
    expect(accept({ type: 'factoid', runId: null, seq: 0 })).toBe(false);
    expect(accept({ type: 'factoid', runId: null, seq: 1 })).toBe(true);
  });
});
