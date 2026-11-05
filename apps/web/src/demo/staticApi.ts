/**
 * The static demo's API: the app's requests answered in the browser, so the page needs no server,
 * no key and no model call. The answers are what the real API sent in replay mode when the demo
 * was built (scripts/build-static-demo.mjs), kept under `demo-data/` next to the page. The app
 * runs as it does against the API: only `fetch` and `EventSource` are replaced, for `/api` only.
 */

const API_PREFIX = '/api/';
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** One event of a recorded stream: its body, and when it was sent after the stream opened. */
export interface RecordedEvent {
  atMs: number;
  data: string;
}

/** A recorded track, as `demo-data/index.json` lists it. */
export interface DemoTrackEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  [field: string]: unknown;
}

/** `demo-data/index.json`. */
export interface DemoIndex {
  replays: unknown[];
  suggestions: DemoTrackEntry[];
  /** The stream the API answers a song without a recording with. */
  refusal: RecordedEvent[];
}

/** `demo-data/<trackId>.json`. */
export interface DemoTrack {
  /** The answer of GET /api/runs/by-track/<trackId>. */
  stored: unknown;
  /** The analysis stream. */
  stream: RecordedEvent[];
  /** The "More facts" stream. */
  moreFacts: RecordedEvent[];
}

/** The API's own folding of a query: lower case, no accents, words split by anything else. */
export function normalizeQuery(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The recorded tracks with a word starting with each word of `query`, as the API suggests them. */
export function suggestionsFor(
  tracks: readonly DemoTrackEntry[],
  query: string,
  limit: number,
): DemoTrackEntry[] {
  const words = normalizeQuery(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  return tracks
    .filter((track) => {
      const haystack = normalizeQuery(`${track.title} ${track.artist} ${track.album}`).split(' ');
      return words.every((word) => haystack.some((token) => token.startsWith(word)));
    })
    .slice(0, limit);
}

/** The recorded track a search text names: exactly one track must match all of its words. */
export function trackForQuery(
  tracks: readonly DemoTrackEntry[],
  query: string,
): DemoTrackEntry | null {
  const matches = suggestionsFor(tracks, query, 2);
  return matches.length === 1 ? matches[0] : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Reads the demo's files; each is fetched once. */
export function demoFiles(baseUrl: string, get: typeof fetch) {
  const cache = new Map<string, Promise<unknown>>();
  const read = <T>(name: string): Promise<T> => {
    let file = cache.get(name);
    if (!file) {
      file = get(`${baseUrl}demo-data/${name}.json`).then((response) => {
        if (!response.ok) throw new Error(`demo-data/${name}.json: HTTP ${response.status}`);
        return response.json();
      });
      cache.set(name, file);
    }
    return file as Promise<T>;
  };
  return {
    index: () => read<DemoIndex>('index'),
    track: (id: string) => read<DemoTrack>(id),
  };
}

export type DemoFiles = ReturnType<typeof demoFiles>;

/** The answer to a request the app makes with `fetch`. `url` holds the path and the query. */
export async function answerRequest(url: URL, method: string, files: DemoFiles): Promise<Response> {
  const path = url.pathname;
  if (method === 'POST' && path === '/api/runs') {
    return json({
      runToken: 'static-demo',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  if (path === '/api/replays') {
    const { replays } = await files.index();
    return json({ success: true, replays });
  }
  if (path === '/api/search/suggest') {
    const { suggestions } = await files.index();
    const limit = Number(url.searchParams.get('limit')) || 5;
    return json({
      success: true,
      suggestions: suggestionsFor(suggestions, url.searchParams.get('query') ?? '', limit),
    });
  }
  const stored = /^\/api\/runs\/by-track\/([^/]+)$/.exec(path);
  if (stored) {
    const id = decodeURIComponent(stored[1]);
    if (!SPOTIFY_ID.test(id)) return json({ code: 'invalid_input', error: 'Not a track id' }, 400);
    const { suggestions } = await files.index();
    if (!suggestions.some((track) => track.id === id)) {
      return json({ code: 'not_found', error: 'No stored result for this track' }, 404);
    }
    return json((await files.track(id)).stored);
  }
  return json({ code: 'live_disabled', error: 'This static demo has no server.' }, 503);
}

/** The recorded events of a stream the app opens; the refusal for a song without a recording. */
export async function eventsFor(url: URL, files: DemoFiles): Promise<RecordedEvent[]> {
  const index = await files.index();
  if (url.pathname === '/api/factoids/more/stream') {
    const title = normalizeQuery(url.searchParams.get('trackTitle') ?? '');
    const artist = normalizeQuery(url.searchParams.get('trackArtist') ?? '');
    const track = index.suggestions.find(
      (entry) => normalizeQuery(entry.title) === title && normalizeQuery(entry.artist) === artist,
    );
    return track ? (await files.track(track.id)).moreFacts : index.refusal;
  }
  const trackId = url.searchParams.get('trackId');
  const track = trackId
    ? index.suggestions.find((entry) => entry.id === trackId)
    : trackForQuery(index.suggestions, url.searchParams.get('query') ?? '');
  return track ? (await files.track(track.id)).stream : index.refusal;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/**
 * How many times slower than the API replays a recording the demo plays it. The API's replay runs
 * at 8 times the recorded speed, which leaves about 2 s to read the steps of an analysis.
 */
export const DEMO_PLAYBACK_STRETCH = 3;

/** An EventSource that plays recorded events at the times they were sent, `stretch` times slower. */
export function staticEventSource(files: DemoFiles, origin: string, stretch = 1) {
  return class StaticEventSource {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSED = CLOSED;
    readonly url: string;
    readonly withCredentials = false;
    readyState: number = CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private timers: ReturnType<typeof setTimeout>[] = [];
    private listeners = new Map<string, Set<EventListener>>();

    constructor(url: string | URL) {
      this.url = String(url);
      eventsFor(new URL(this.url, origin), files).then(
        (events) => this.play(events),
        () => this.lose(),
      );
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListener) {
      this.listeners.get(type)?.delete(listener);
    }

    private emit(event: Event) {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    }

    private play(events: RecordedEvent[]) {
      if (this.readyState === CLOSED) return;
      this.readyState = OPEN;
      const opened = new Event('open');
      this.onopen?.(opened);
      this.emit(opened);
      for (const { atMs, data } of events) {
        this.timers.push(
          setTimeout(() => {
            if (this.readyState === CLOSED) return;
            const message = new MessageEvent('message', { data });
            this.onmessage?.(message);
            this.emit(message);
          }, atMs * stretch),
        );
      }
    }

    private lose() {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      const error = new Event('error');
      this.onerror?.(error);
      this.emit(error);
    }

    close() {
      this.readyState = CLOSED;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
    }
  };
}

/** Replaces `fetch` and `EventSource` for the app's `/api` requests. */
export function installStaticApi(target: typeof globalThis = globalThis) {
  const realFetch = target.fetch.bind(target);
  const { origin, href } = target.location;
  const files = demoFiles(import.meta.env.BASE_URL, realFetch);
  target.fetch = async (input, init) => {
    const text = input instanceof Request ? input.url : String(input);
    const url = new URL(text, href);
    if (url.origin !== origin || !url.pathname.startsWith(API_PREFIX)) {
      return realFetch(input, init);
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return answerRequest(url, method.toUpperCase(), files);
  };
  target.EventSource = staticEventSource(
    files,
    origin,
    DEMO_PLAYBACK_STRETCH,
  ) as unknown as typeof EventSource;
}
