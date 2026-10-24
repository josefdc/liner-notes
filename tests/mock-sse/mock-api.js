// Browser-side stand-in for the API, injected with page.addInitScript before the app loads.
// Configure it first with `window.__mockApi = { suggestions, streams, fetchStatus }`:
//   suggestions: candidates returned by /api/search/suggest
//   fetchStatus: { "<path>": <HTTP status> } makes a request on that path fail with it
//   suggestionsByQuery: { "<query>": [candidate, ...] } overrides `suggestions` per query
//   suggestWaits: { "<query>": "<name>" } holds the suggestions for that query until the test
//                calls `window.__mockApi.release("<name>")`
//   streams:     { "<path>": [event, ...] } — events replayed, in order, by an EventSource
//                opened on that path (e.g. "/api/analyze/stream"); when they run out the
//                stream ends like a server response does (onerror unless the app closed it).
//                `{ "<path>": { opens: [[event, ...], [event, ...]] } }` gives each opening of
//                the path its own events (the last list repeats for later openings).
// The events are replayed as given: tests install the mock with useMockApi (tests/web/mock.ts),
// which first adds the run id and `seq` the API sends and checks every event against the
// contract (tests/mock-sse/envelope.ts).
// Besides plain events, a list may hold three directives:
//   { "$wait": "<name>" }              pauses the stream until the test calls
//                                      `window.__mockApi.release("<name>")` (or already has)
//   { "$event": "<name>", "data": {} } sends a named SSE event (`event: <name>`), seen only
//                                      by listeners added with addEventListener(name)
//   { "$unchecked": {event} }          sends an event the contract does not accept (an
//                                      unknown type, an older server's event) as a data message
// Every API request (any URL whose path starts with /api/) is recorded in
// `window.__mockApi.log`. What each stream does is recorded in `window.__mockApi.streamLog`
// as "<path> open", "<path> <event type>", "<path> closed" (by the app), "<path> ended"
// (the events ran out) or "<path> reconnect".
// Like a real EventSource, a stream that ends while the app has not closed it reconnects to
// the same URL after a short delay (a new request, logged in `log` too) and plays that path's
// events again; only a closed stream stays closed. A stream left open by the app therefore
// shows up as an extra request. API requests the configuration does not cover fail, so a test
// never depends on a real backend.

(() => {
  const config = window.__mockApi ?? { suggestions: [], streams: {} };
  config.log = [];
  config.streamLog = [];
  const isApi = (url) => new URL(url, location.href).pathname.startsWith("/api/");
  const pathOf = (url) => new URL(url, location.href).pathname;

  const released = new Set();
  const waiting = new Map();
  config.release = (name) => {
    released.add(name);
    const resume = waiting.get(name) ?? [];
    waiting.delete(name);
    for (const fn of resume) fn();
  };
  const whenReleased = (name, fn) => {
    if (released.has(name)) {
      fn();
      return;
    }
    waiting.set(name, [...(waiting.get(name) ?? []), fn]);
  };

  const openCounts = new Map();
  const eventsFor = (path) => {
    const entry = config.streams?.[path];
    const count = openCounts.get(path) ?? 0;
    openCounts.set(path, count + 1);
    if (!entry || Array.isArray(entry)) return entry;
    return entry.opens[Math.min(count, entry.opens.length - 1)];
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isApi(url)) return realFetch(input, init);
    config.log.push(`fetch ${pathOf(url)}`);
    const status = config.fetchStatus?.[pathOf(url)];
    if (status) {
      return new Response(JSON.stringify({ success: false, error: "mocked failure" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathOf(url) === "/api/search/suggest") {
      const query = new URL(url, location.href).searchParams.get("query") ?? "";
      const wait = config.suggestWaits?.[query];
      if (wait) await new Promise((resolve) => whenReleased(wait, resolve));
      const suggestions = config.suggestionsByQuery?.[query] ?? config.suggestions ?? [];
      return new Response(JSON.stringify({ success: true, suggestions }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, error: "not mocked" }), { status: 503 });
  };

  // How long a real EventSource waits before it reconnects (shortened).
  const RECONNECT_DELAY_MS = 100;

  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.listeners = new Map();
      this.path = pathOf(url);
      this.connect();
    }

    connect() {
      const { path } = this;
      config.log.push(`stream ${path}${new URL(this.url, location.href).search}`);
      config.streamLog.push(`${path} open`);
      const events = eventsFor(path);
      let index = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        if (!events) {
          // The request itself failed (no such stream): a real EventSource gives up.
          this.readyState = 2;
          config.streamLog.push(`${path} ended`);
          this.dispatch("error", new Event("error"));
          return;
        }
        this.readyState = 1;
        this.dispatch("open", new Event("open"));
        const next = () => {
          if (this.readyState === 2) return;
          if (index >= events.length) {
            // The server has ended the response. A real EventSource reports that through
            // onerror and, unless the app closes the stream, reconnects.
            this.readyState = 0;
            config.streamLog.push(`${path} ended`);
            this.dispatch("error", new Event("error"));
            setTimeout(() => {
              if (this.readyState !== 0) return;
              config.streamLog.push(`${path} reconnect`);
              this.connect();
            }, RECONNECT_DELAY_MS);
            return;
          }
          const event = events[index++];
          if (event.$wait) {
            whenReleased(event.$wait, () => setTimeout(next, 0));
            return;
          }
          if (event.$unchecked) {
            config.streamLog.push(`${path} ${event.$unchecked.type}`);
            this.dispatch(
              "message",
              new MessageEvent("message", { data: JSON.stringify(event.$unchecked) }),
            );
          } else if (event.$event) {
            config.streamLog.push(`${path} ${event.$event}`);
            this.dispatch(
              event.$event,
              new MessageEvent(event.$event, { data: JSON.stringify(event.data ?? {}) }),
            );
          } else {
            config.streamLog.push(`${path} ${event.type}`);
            this.dispatch("message", new MessageEvent("message", { data: JSON.stringify(event) }));
          }
          setTimeout(next, 50);
        };
        setTimeout(next, 50);
      }, 20);
    }

    dispatch(type, event) {
      if (this.readyState === 2 && type !== "error") return;
      this[`on${type}`]?.(event);
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type, listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
      );
    }

    close() {
      if (this.readyState !== 2) config.streamLog.push(`${this.path} closed`);
      this.readyState = 2;
    }
  }

  window.EventSource = MockEventSource;
})();
