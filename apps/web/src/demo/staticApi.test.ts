import { describe, expect, it, vi } from 'vitest';
import {
  answerRequest,
  type DemoFiles,
  type DemoTrackEntry,
  eventsFor,
  normalizeQuery,
  staticEventSource,
  suggestionsFor,
  trackForQuery,
} from './staticApi';

const HUNG_UP: DemoTrackEntry = {
  id: '3850dYVgOFIXJh5U4BFEWH',
  title: 'Hung Up',
  artist: 'Madonna',
  album: 'Confessions on a Dance Floor',
};
const ONE_MORE_TIME: DemoTrackEntry = {
  id: '0DiWol3AO6WpXZgp0goxAV',
  title: 'One More Time',
  artist: 'Daft Punk',
  album: 'Discovery',
};
const REFUSAL = [{ atMs: 0, data: '{"type":"error","code":"live_disabled"}' }];

const files: DemoFiles = {
  index: async () => ({
    replays: [HUNG_UP, ONE_MORE_TIME],
    suggestions: [HUNG_UP, ONE_MORE_TIME],
    refusal: REFUSAL,
  }),
  track: async (id) => ({
    stored: { success: true, analysis: { id } },
    stream: [{ atMs: 0, data: `{"type":"connected","track":"${id}"}` }],
    moreFacts: [{ atMs: 0, data: `{"type":"done","track":"${id}"}` }],
  }),
};

const at = (path: string) => new URL(path, 'https://demo.test');

describe('finding a recorded track', () => {
  it('folds case and accents as the API does', () => {
    expect(normalizeQuery('  Beyoncé — HALO! ')).toBe('beyonce halo');
  });

  it('suggests the tracks with a word starting with each word typed', () => {
    const tracks = [HUNG_UP, ONE_MORE_TIME];
    expect(suggestionsFor(tracks, 'madon', 5)).toEqual([HUNG_UP]);
    expect(suggestionsFor(tracks, 'more daft', 5)).toEqual([ONE_MORE_TIME]);
    expect(suggestionsFor(tracks, 'donna', 5)).toEqual([]);
    expect(suggestionsFor(tracks, '   ', 5)).toEqual([]);
  });

  it('takes a search text as a track only when it names one track', () => {
    const tracks = [HUNG_UP, ONE_MORE_TIME];
    expect(trackForQuery(tracks, 'One More Time Daft Punk')).toEqual(ONE_MORE_TIME);
    expect(trackForQuery(tracks, 'Bohemian Rhapsody')).toBeNull();
    expect(trackForQuery([HUNG_UP, { ...HUNG_UP, id: 'other' }], 'Hung Up')).toBeNull();
  });
});

describe('the answers to requests', () => {
  it('issues a run token that is still valid', async () => {
    const body = await (await answerRequest(at('/api/runs'), 'POST', files)).json();
    expect(body.runToken).toBe('static-demo');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('lists the recordings and the suggestions', async () => {
    const replays = await (await answerRequest(at('/api/replays'), 'GET', files)).json();
    expect(replays.replays).toHaveLength(2);
    const suggest = at('/api/search/suggest?query=hung&limit=5');
    const body = await (await answerRequest(suggest, 'GET', files)).json();
    expect(body.suggestions).toEqual([HUNG_UP]);
  });

  it('answers a stored result as the API does', async () => {
    const found = await answerRequest(at(`/api/runs/by-track/${HUNG_UP.id}`), 'GET', files);
    expect((await found.json()).analysis.id).toBe(HUNG_UP.id);

    const missing = await answerRequest(
      at('/api/runs/by-track/5MIgTjcn94EPeSUUo8dx4q'),
      'GET',
      files,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('not_found');

    const invalid = await answerRequest(at('/api/runs/by-track/nope'), 'GET', files);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('invalid_input');
  });

  it('refuses anything else as live analysis being off', async () => {
    const answer = await answerRequest(at('/api/analyze'), 'POST', files);
    expect(answer.status).toBe(503);
    expect((await answer.json()).code).toBe('live_disabled');
  });
});

describe('the streams', () => {
  it('plays the recording of the track asked for, by id or by name', async () => {
    const byId = await eventsFor(at(`/api/analyze/stream?trackId=${HUNG_UP.id}`), files);
    expect(byId[0].data).toContain(HUNG_UP.id);
    const byName = await eventsFor(at('/api/analyze/stream?query=one+more+time'), files);
    expect(byName[0].data).toContain(ONE_MORE_TIME.id);
  });

  it('refuses a song without a recording', async () => {
    expect(await eventsFor(at('/api/analyze/stream?query=Bohemian+Rhapsody'), files)).toBe(REFUSAL);
    expect(await eventsFor(at('/api/analyze/stream?trackId=unknown'), files)).toBe(REFUSAL);
  });

  it('plays a track\'s "More facts" answer by its title and artist', async () => {
    const url = at('/api/factoids/more/stream?trackTitle=Hung+Up&trackArtist=Madonna&round=0');
    expect((await eventsFor(url, files))[0].data).toContain(HUNG_UP.id);
  });

  it('opens, sends the events in time and stops when closed', async () => {
    vi.useFakeTimers();
    try {
      const Source = staticEventSource(
        {
          ...files,
          track: async () => ({
            stored: null,
            stream: [
              { atMs: 10, data: 'first' },
              { atMs: 20, data: 'second' },
            ],
            moreFacts: [],
          }),
        },
        'https://demo.test',
      );
      const source = new Source(`/api/analyze/stream?trackId=${HUNG_UP.id}`);
      const opened = vi.fn();
      const received: string[] = [];
      source.onopen = opened;
      source.onmessage = (event) => {
        received.push(event.data);
      };
      await vi.advanceTimersByTimeAsync(0);
      expect(opened).toHaveBeenCalledOnce();
      expect(source.readyState).toBe(Source.OPEN);
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toEqual(['first']);
      source.close();
      await vi.advanceTimersByTimeAsync(50);
      expect(received).toEqual(['first']);
      expect(source.readyState).toBe(Source.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stream whose file cannot be read as lost', async () => {
    const Source = staticEventSource(
      {
        ...files,
        index: async () => {
          throw new Error('offline');
        },
      },
      'https://demo.test',
    );
    const source = new Source('/api/analyze/stream?query=x');
    const lost = new Promise((resolve) => {
      source.onerror = resolve;
    });
    await lost;
    expect(source.readyState).toBe(Source.CLOSED);
  });
});
