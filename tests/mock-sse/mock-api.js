// Browser-side stand-in for the API, injected with page.addInitScript before the app loads.
// Configure it first with `window.__mockApi = { suggestions, streams }`:
//   suggestions: candidates returned by /api/search/suggest
//   streams:     { "<path>": [event, ...] } — events replayed, in order, by an EventSource
//                opened on that path (e.g. "/api/analyze/stream")
// Every request is recorded in `window.__mockApi.log`. Requests to the API that the
// configuration does not cover fail, so a test never depends on a real backend.

(() => {
  const config = window.__mockApi ?? { suggestions: [], streams: {} };
  config.log = [];
  const isApi = (url) => new URL(url, location.href).port === "3001";
  const pathOf = (url) => new URL(url, location.href).pathname;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
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
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      config.log.push(
        `stream ${new URL(url, location.href).pathname}${new URL(url, location.href).search}`,
      );
      const events = config.streams?.[pathOf(url)];
      let index = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        if (!events) {
          this.readyState = 2;
          this.onerror?.(new Event("error"));
          return;
        }
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        const next = () => {
          if (this.readyState === 2 || index >= events.length) return;
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(events[index++]) }));
          setTimeout(next, 50);
        };
        setTimeout(next, 50);
      }, 20);
    }

    addEventListener() {}

    removeEventListener() {}

    close() {
      this.readyState = 2;
    }
  }

  window.EventSource = MockEventSource;
})();
