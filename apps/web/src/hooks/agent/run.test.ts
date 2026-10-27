import { describe, expect, it } from 'vitest';
import { newBranches } from './progress';
import { advance, newRun, newRunLife, type RunAction, type RunLife, runReducer } from './run';
import type { SearchCandidate } from './types';

const candidate = (id: string): SearchCandidate => ({
  id,
  title: 'Hurt',
  artist: 'Johnny Cash',
  album: 'A',
  coverUrl: '',
});
const list = [candidate('c1'), candidate('c2')];
const token = { runToken: 'token-1', expiresAt: 1 };
const life = (change: Partial<RunLife> = {}): RunLife => ({ ...newRunLife(), ...change });

describe('runReducer', () => {
  it.each<[string, RunLife, RunAction, RunLife]>([
    [
      'start: the token the run starts with',
      life(),
      { type: 'tokenIssued', token },
      life({ token }),
    ],
    [
      'connected: the run keeps its thread',
      life(),
      { type: 'connected', threadId: 't1' },
      life({ threadId: 't1' }),
    ],
    [
      'connected without a thread',
      life({ threadId: 't0' }),
      { type: 'connected', threadId: '' },
      life(),
    ],
    ['a replay notice', life(), { type: 'replayNoticed' }, life({ replay: true })],
    [
      'the picker opens and the run waits',
      life({ threadId: 't1' }),
      { type: 'pickerOpened', threadId: 't2', candidates: list },
      life({ phase: 'awaiting-selection', threadId: 't2', candidates: list }),
    ],
    [
      'a picker without a thread keeps the one the run has',
      life({ threadId: 't1' }),
      { type: 'pickerOpened', threadId: '', candidates: list },
      life({ phase: 'awaiting-selection', threadId: 't1', candidates: list }),
    ],
    [
      'resume: a pick with a thread is kept for the resume',
      life({ phase: 'awaiting-selection', threadId: 't1', candidates: list }),
      { type: 'picked', candidate: list[1] },
      life({ threadId: 't1', candidates: list, picked: list[1] }),
    ],
    [
      'a pick without a thread is not kept: the run asks for it by id',
      life({ phase: 'awaiting-selection', candidates: list }),
      { type: 'picked', candidate: list[1] },
      life({ candidates: list }),
    ],
    [
      'done: a live result',
      life(),
      { type: 'completed', wholeRecording: false },
      life({ phase: 'complete' }),
    ],
    [
      'done: a whole recording is a replay',
      life(),
      { type: 'completed', wholeRecording: true },
      life({ phase: 'complete', replay: true }),
    ],
    [
      'done: a replay stays one',
      life({ replay: true }),
      { type: 'completed', wholeRecording: false },
      life({ phase: 'complete', replay: true }),
    ],
    [
      'error, refused, auth_expired and the rate limit fail the run',
      life({ token }),
      { type: 'failed' },
      life({ phase: 'failed', token }),
    ],
  ])('%s', (_name, before, action, expected) => {
    expect(runReducer(before, action)).toEqual(expected);
  });

  it('keeps the same candidate list when the picker sends the same ids again', () => {
    const before = life({ candidates: list });
    const after = runReducer(before, {
      type: 'pickerOpened',
      threadId: 't1',
      candidates: list.map((c) => ({ ...c })),
    });
    expect(after.candidates).toBe(list);
    const other = runReducer(before, {
      type: 'pickerOpened',
      threadId: 't1',
      candidates: [list[0]],
    });
    expect(other.candidates).toEqual([list[0]]);
  });

  it('keeps the life as it is when the branches did not change', () => {
    const before = life();
    expect(runReducer(before, { type: 'branchesChanged', branches: before.branches })).toBe(before);
    const branches = { ...newBranches(), researched: true };
    expect(runReducer(before, { type: 'branchesChanged', branches }).branches).toBe(branches);
  });

  it('never changes the life it is given', () => {
    const before = life();
    const copy = structuredClone(before);
    runReducer(before, { type: 'failed' });
    expect(before).toEqual(copy);
  });
});

describe('newRun', () => {
  it('keeps a Spotify track id and how its row was picked, for a retry', () => {
    const run = newRun('Hurt', { trackId: '28cnXtME493VX9NOw9cIUh', pickedBy: 'click' });
    expect([run.query, run.trackId, run.pickedBy, run.expectedTrackId]).toEqual([
      'Hurt',
      '28cnXtME493VX9NOw9cIUh',
      'click',
      null,
    ]);
    expect(run.life).toEqual(newRunLife());
  });

  it('drops a placeholder id and how it was picked', () => {
    const run = newRun('Hurt', { trackId: 'placeholder', pickedBy: 'click', expectedTrackId: 'x' });
    expect([run.trackId, run.pickedBy, run.expectedTrackId]).toEqual([null, null, 'x']);
  });

  it('moves a run on with advance', () => {
    const run = newRun('Hurt');
    advance(run, { type: 'failed' });
    expect(run.life.phase).toBe('failed');
  });
});
