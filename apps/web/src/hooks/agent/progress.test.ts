import { describe, expect, it } from 'vitest';
import {
  type Branches,
  CHECK_NOTE,
  INITIAL_PROGRESS,
  newBranches,
  type ProgressState,
  progressReducer,
  RESUME_NOTE,
  reportStep,
  type Step,
} from './progress';
import type { AgentAction } from './state';

const at = (
  status: ProgressState['status'],
  statusNote: string | null = null,
  isLoading = true,
): ProgressState => ({ status, statusNote, isLoading });

const step = (value: Step): AgentAction => ({ type: 'stepReported', step: value });

describe('progressReducer', () => {
  it.each<[string, ProgressState, AgentAction, ProgressState]>([
    ['start connects and waits', INITIAL_PROGRESS, { type: 'started' }, at('connecting')],
    [
      'start drops what the last run showed',
      at('error', null, false),
      { type: 'started' },
      at('connecting'),
    ],
    [
      'the check says so while it runs',
      at('connecting'),
      { type: 'checkStarted' },
      at('connecting', CHECK_NOTE),
    ],
    [
      'the check line goes once it is over',
      at('connecting', CHECK_NOTE),
      { type: 'checkEnded' },
      at('connecting'),
    ],
    [
      'the stream opening moves on to searching',
      at('connecting'),
      { type: 'opened' },
      at('searching'),
    ],
    [
      'a step moves the run on',
      at('searching'),
      step({ status: 'analyzing', note: null }),
      at('analyzing'),
    ],
    [
      'a step keeps the server words it brings',
      at('analyzing'),
      step({ status: 'composing', note: 'No notes are written' }),
      at('composing', 'No notes are written'),
    ],
    [
      'a measurement that ended leaves measuring for a lower step',
      at('measuring'),
      step({ status: 'analyzing', note: null, ended: true }),
      at('analyzing'),
    ],
    [
      'the picker stops waiting and asks its question',
      at('searching'),
      { type: 'pickerOpened', candidates: [], question: 'Pick one' },
      at('disambiguation', 'Pick one', false),
    ],
    [
      'a resume reads the picked track',
      at('disambiguation', 'Pick one', false),
      { type: 'resumed' },
      at('analyzing', RESUME_NOTE),
    ],
    [
      'done: the result ends the run',
      at('composing', 'words'),
      { type: 'completed', trackData: {} as never, replay: false },
      at('complete', null, false),
    ],
    [
      'error, refused, auth_expired and the rate limit all end the run',
      at('researching', 'words'),
      { type: 'failed', message: 'm', code: 'rate_limited', retryAt: 5 },
      at('error', null, false),
    ],
    ['cancel goes back to the start', at('researching'), { type: 'reset' }, INITIAL_PROGRESS],
    [
      'restore previous (a reset after a result) goes back to the start',
      at('complete', null, false),
      { type: 'reset' },
      INITIAL_PROGRESS,
    ],
  ])('%s', (_name, before, action, expected) => {
    expect(progressReducer(before, action)).toEqual(expected);
  });

  it.each<[string, ProgressState, AgentAction]>([
    [
      'a step reported after a later one',
      at('composing'),
      step({ status: 'analyzing', note: null }),
    ],
    [
      'the same step with the same words',
      at('researching', 'n'),
      step({ status: 'researching', note: 'n' }),
    ],
    ['the same step that keeps its words', at('composing', 'n'), step({ status: 'composing' })],
    [
      'the check ending when another line is shown',
      at('connecting', 'other'),
      { type: 'checkEnded' },
    ],
    ['the stream opening after the run moved on', at('analyzing'), { type: 'opened' }],
    [
      'a log line',
      at('searching'),
      { type: 'logged', log: { id: 'l', message: 'm', timestamp: 't' } },
    ],
    ['a replay notice', at('searching'), { type: 'replayNoticed' }],
    [
      'more facts',
      at('complete', null, false),
      { type: 'moreFactsChanged', moreFacts: {} as never },
    ],
  ])('changes nothing for %s', (_name, before, action) => {
    expect(progressReducer(before, action)).toBe(before);
  });

  it('keeps the start state for a reset', () => {
    expect(progressReducer(INITIAL_PROGRESS, { type: 'reset' })).toBe(INITIAL_PROGRESS);
  });
});

const branches = (change: Partial<Branches> = {}): Branches => ({ ...newBranches(), ...change });

describe('reportStep', () => {
  it.each<
    [string, Branches, string | undefined, string | undefined, string, Branches, Step | null]
  >([
    [
      'the scout searches',
      branches(),
      'scout',
      'NET-100',
      'x',
      branches(),
      { status: 'searching', note: null },
    ],
    [
      'the historian researches',
      branches(),
      'historian',
      'RESEARCH-START',
      'Starting',
      branches({ researched: true }),
      { status: 'researching', note: null },
    ],
    [
      "the historian's stored research keeps its words",
      branches(),
      'historian',
      'RESEARCH-FOUND',
      'Using the research stored by an earlier run',
      branches({ researched: true, researchNote: 'Using the research stored by an earlier run' }),
      { status: 'researching', note: 'Using the research stored by an earlier run' },
    ],
    [
      'the historian does not replace a measurement under way',
      branches({ measuring: true }),
      'historian',
      'RESEARCH-START',
      'x',
      branches({ measuring: true, researched: true }),
      null,
    ],
    [
      'the engineer measures on AUDIO-INIT',
      branches(),
      'engineer',
      'AUDIO-INIT',
      'x',
      branches({ measuring: true }),
      { status: 'measuring', note: null },
    ],
    [
      'the engineer analyses before any research',
      branches(),
      'engineer',
      'AUDIO-CACHE',
      'x',
      branches(),
      { status: 'analyzing', note: null, ended: false },
    ],
    [
      'the measurement ends on the research beside it',
      branches({ measuring: true, researched: true, researchNote: 'r' }),
      'engineer',
      'AUDIO-DONE',
      'x',
      branches({ researched: true, researchNote: 'r' }),
      { status: 'researching', note: 'r', ended: true },
    ],
    [
      'the composer ends a measurement and composes',
      branches({ measuring: true }),
      'composer',
      'LLM-START',
      'x',
      branches(),
      { status: 'composing', note: undefined },
    ],
    [
      "the composer's fallback keeps its words",
      branches(),
      'composer',
      'LLM-ERROR',
      'No notes are written',
      branches(),
      { status: 'composing', note: 'No notes are written' },
    ],
    [
      'the verifier checks on its model lines',
      branches(),
      'verifier',
      'VERIFY-START',
      'x',
      branches(),
      { status: 'checking', note: null },
    ],
    [
      'the verifier does not check on a cover-art lookup',
      branches(),
      'verifier',
      'NET-200',
      'x',
      branches(),
      null,
    ],
    ['another node is no step', branches(), 'replay', 'SYS-INIT', 'x', branches(), null],
  ])('%s', (_name, before, node, code, message, after, expected) => {
    const report = reportStep(before, node, code, message);
    expect(report.branches).toEqual(after);
    expect(report.step).toEqual(expected);
  });

  it('returns the same branches when a line changes none of them', () => {
    const before = branches({ researched: true });
    expect(reportStep(before, 'scout', undefined, 'x').branches).toBe(before);
    expect(reportStep(before, 'historian', 'RESEARCH-START', 'x').branches).toBe(before);
  });
});
