import { describe, expect, it } from 'vitest';
import recordingRaw from '../../../../../fixtures/replays/one-more-time-daft-punk.json?raw';
import type { AgentLog } from '../../types';
import { appendLog, droppedLines, LOG_LIMIT, type NewLog, writtenLines } from './runLog';

const line = (message: string, code?: AgentLog['code'], node?: string): NewLog => ({
  id: `id-${message}-${Math.random()}`,
  message,
  timestamp: '2026-01-01T00:00:00.000Z',
  code,
  node,
});

/** The log after writing each line in turn. */
function write(lines: NewLog[], limit = LOG_LIMIT): AgentLog[] {
  return lines.reduce<AgentLog[]>((logs, next) => appendLog(logs, next, limit), []);
}

describe('appendLog', () => {
  it('numbers the lines of a run from 0', () => {
    const logs = write([line('a'), line('b'), line('c')]);
    expect(logs.map((log) => [log.message, log.index])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(droppedLines(logs)).toBe(0);
    expect(writtenLines(logs)).toBe(3);
  });

  it('shows a line that repeats the one before it once, and returns the same log', () => {
    const first = write([line('Searching: sample history on the web', undefined, 'research_tool')]);
    const again = appendLog(
      first,
      line('Searching: sample history on the web', undefined, 'research_tool'),
    );
    expect(again).toBe(first);
    expect(writtenLines(again)).toBe(1);
  });

  it('keeps a line that only repeats an earlier one, not the last', () => {
    const logs = write([line('a'), line('b'), line('a')]);
    expect(logs.map((log) => log.message)).toEqual(['a', 'b', 'a']);
  });

  it('keeps the same words from another step or with another code', () => {
    const logs = write([
      line('Research finished', 'RESEARCH-FOUND', 'historian'),
      line('Research finished', 'SYS-WARN', 'historian'),
      line('Research finished', 'SYS-WARN', 'composer'),
    ]);
    expect(logs).toHaveLength(3);
  });

  it('keeps the latest lines only, and says how many were dropped', () => {
    const lines = Array.from({ length: 25 }, (_, n) => line(`line ${n}`));
    const logs = write(lines, 10);
    expect(logs).toHaveLength(10);
    expect(logs[0].message).toBe('line 15');
    expect(logs.at(-1)?.message).toBe('line 24');
    expect(logs.map((log) => log.index)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(droppedLines(logs)).toBe(15);
    expect(writtenLines(logs)).toBe(25);
  });

  it('holds at most LOG_LIMIT lines however long the run', () => {
    const lines = Array.from({ length: LOG_LIMIT * 3 }, (_, n) => line(`line ${n}`));
    const logs = write(lines);
    expect(logs).toHaveLength(LOG_LIMIT);
    expect(writtenLines(logs)).toBe(LOG_LIMIT * 3);
  });

  it('keeps 100 lines: several times the recorded demo run, replayed whole', () => {
    const record = JSON.parse(recordingRaw) as {
      events: Array<{ event: { type: string; message?: string } }>;
    };
    const status = record.events.filter(
      ({ event }) => event.type === 'status' && event.message,
    ).length;
    // Replayed, the page shows those lines, the replay notice, and its own three ("Searching
    // for…", "Connected…", the line that ends the run).
    const replayed = status + 1 + 3;
    expect(replayed).toBeGreaterThan(10);
    expect(LOG_LIMIT).toBeGreaterThanOrEqual(4 * replayed);
    // A different limit is a choice to make here, with its evidence.
    expect(LOG_LIMIT).toBe(100);
  });

  it('counts a log whose lines carry no place (written before the places) by its length', () => {
    const logs: AgentLog[] = [
      { id: 'a', message: 'a', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'b', message: 'b', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    expect(droppedLines(logs)).toBe(0);
    expect(writtenLines(logs)).toBe(2);
    expect(appendLog(logs, line('c')).at(-1)?.index).toBe(2);
  });
});
