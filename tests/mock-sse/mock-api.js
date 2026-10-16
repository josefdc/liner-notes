// Browser-side stand-in for the API, injected with page.addInitScript before the app loads.
// Configure it first with `window.__mockApi = { suggestions, streams }`:
//   suggestions: candidates returned by /api/search/suggest
//   streams:     { "<path>": [event, ...] } — events replayed, in order, by an EventSource
//                opened on that path (e.g. "/api/analyze/stream"); when they run out the
//                stream ends like a server response does (onerror unless the app closed it).
//                `{ "<path>": { opens: [[event, ...], [event, ...]] } }` gives each opening of
//                the path its own events (the last list repeats for later openings).
// Besides plain events, a list may hold two directives:
//   { "$wait": "<name>" }              pauses the stream until the test calls
//                                      `window.__mockApi.release("<name>")` (or already has)
//   { "$event": "<name>", "data": {} } sends a named SSE event (`event: <name>`), seen only
//                                      by listeners added with addEventListener(name)
// Every API request (any URL whose path starts with /api/) is recorded in
// `window.__mockApi.log`. What each stream does is recorded in `window.__mockApi.streamLog`
// as "<path> open", "<path> <event type>", "<path> closed" (by the app) or "<path> ended"
// (the events ran out). API requests the configuration does not cover fail, so a test never
// depends on a real backend.

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
    if (pathOf(url) === "/api/search/suggest") {
      return new Response(
        JSON.stringify({ success: true, suggestions: config.suggestions ?? [] }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ success: false, error: "not mocked" }), { status: 503 });
  };

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
      const path = pathOf(url);
      this.path = path;
      config.log.push(`stream ${path}${new URL(url, location.href).search}`);
      config.streamLog.push(`${path} open`);
      const events = eventsFor(path);
      let index = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        if (!events) {
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
            // onerror unless the app already closed the stream (it closes on "done").
            this.readyState = 0;
            config.streamLog.push(`${path} ended`);
            this.dispatch("error", new Event("error"));
            return;
          }
          const event = events[index++];
          if (event.$wait) {
            whenReleased(event.$wait, () => setTimeout(next, 0));
            return;
          }
          if (event.$event) {
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
