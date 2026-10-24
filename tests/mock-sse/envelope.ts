/**
 * What the API's event streams add to every event, applied to the mock API's streams: the run's
 * id (`runId`) and the event's position in the stream (`seq`, from 0 on each opening of a path;
 * heartbeats carry none). An event that names its own `runId` or `seq` keeps it (a test can send
 * a repeat that way) and does not move the count.
 *
 * The run id of an analysis stream is the thread id of its events (as on the API, where the run
 * id is the thread id); a stream with none (a refused resume) belongs to the fixture's first
 * thread. Factoid streams do not know their analysis run: their run id is null.
 *
 * Directives of the mock server are kept, except `{ "$unchecked": event }`: an event the
 * contract does not accept (an unknown type, an older server's event), enveloped like the
 * others but left out of the contract check (see `contractMisfits`).
 */

type Event = { type?: unknown; threadId?: unknown; [field: string]: unknown };
type Entry = Event[] | { opens: Event[][] };
export type MockConfig = { streams?: Record<string, Entry>; [field: string]: unknown };

const isFactoidPath = (path: string) => path.startsWith("/api/factoids/");

/** A plain event, not a directive of the mock server. */
const isEvent = (event: Event) => typeof event.type === "string";

const listsOf = (entry: Entry) => (Array.isArray(entry) ? [entry] : entry.opens);

function firstThread(events: Event[]): string | undefined {
  const event = events.find((e) => isEvent(e) && typeof e.threadId === "string" && e.threadId);
  return event?.threadId as string | undefined;
}

function envelopeList(events: Event[], runId: string | null): Event[] {
  let seq = 0;
  const stamp = (event: Event): Event => {
    const numbered = event.type === "heartbeat" || "seq" in event ? {} : { seq: seq++ };
    return { runId, ...numbered, ...event };
  };
  return events.map((event) => {
    if (isEvent(event)) return stamp(event);
    if (event.$unchecked) return { $unchecked: stamp(event.$unchecked as Event) };
    return event;
  });
}

/** The configuration with every stream event carrying `runId` and `seq` as the API sends them. */
export function withEnvelope<T extends MockConfig>(config: T): T {
  if (!config.streams) return config;
  const analysisEvents = Object.entries(config.streams)
    .filter(([path]) => !isFactoidPath(path))
    .flatMap(([, entry]) => listsOf(entry).flat());
  const fixtureRun = firstThread(analysisEvents) ?? "mock-run";

  const streams: Record<string, Entry> = {};
  for (const [path, entry] of Object.entries(config.streams)) {
    const envelope = (events: Event[]) =>
      envelopeList(events, isFactoidPath(path) ? null : (firstThread(events) ?? fixtureRun));
    streams[path] = Array.isArray(entry)
      ? envelope(entry)
      : { ...entry, opens: entry.opens.map(envelope) };
  }
  return { ...config, streams };
}

/** A schema with `safeParse`, as the contract's unions have. */
type Schema = {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
};

/**
 * The stream events of a configuration that the contract does not accept, as
 * "<path> #<index> <type>: <problems>"; `$unchecked` events are left out.
 */
export function contractMisfits(
  config: MockConfig,
  schemas: { analysis: Schema; factoids: Schema },
): string[] {
  const misfits: string[] = [];
  for (const [path, entry] of Object.entries(config.streams ?? {})) {
    const schema = isFactoidPath(path) ? schemas.factoids : schemas.analysis;
    for (const events of listsOf(entry)) {
      events.forEach((event, index) => {
        if (!isEvent(event)) return;
        const parsed = schema.safeParse(event);
        if (parsed.success) return;
        const problems = (parsed.error?.issues ?? [])
          .map((issue) => `${issue.path.map(String).join(".") || "(event)"} ${issue.message}`)
          .join("; ");
        misfits.push(`${path} #${index} ${String(event.type)}: ${problems}`);
      });
    }
  }
  return misfits;
}

const OUTCOMES = new Set(["complete", "interrupt", "error"]);

/**
 * The streams of a configuration that break the rules the API keeps on every stream it sends,
 * as "<path> (opening <n>): <problem>": one run id, `seq` 0, 1, 2… on every event but
 * heartbeats, at most one `done` and nothing after it, and on an analysis stream at most one
 * outcome (`complete`, `interrupt` or `error`), exactly one when the stream ends with `done`,
 * and none after `done`. A stream that holds an `$unchecked` event, or an event that names its
 * own `runId` or `seq`, sends something the API would not on purpose and is not checked.
 */
export function streamRuleBreaks(config: MockConfig): string[] {
  const breaks: string[] = [];
  for (const [path, entry] of Object.entries(config.streams ?? {})) {
    listsOf(entry).forEach((list, opening) => {
      const where = `${path} (opening ${opening + 1})`;
      if (list.some((event) => event.$unchecked)) return;
      const events = list.filter(isEvent);
      if (events.some((event) => "runId" in event || "seq" in event)) return;
      const enveloped = withEnvelope({ streams: { [path]: events } }).streams?.[path] as Event[];

      if (new Set(enveloped.map((event) => event.runId)).size > 1) {
        breaks.push(`${where}: more than one run id`);
      }
      const numbered = enveloped.filter((event) => event.type !== "heartbeat");
      if (numbered.some((event, index) => event.seq !== index)) {
        breaks.push(`${where}: seq is not 0, 1, 2…`);
      }
      const done = events.findIndex((event) => event.type === "done");
      if (done !== -1 && done !== events.length - 1) {
        breaks.push(`${where}: events after done`);
      }
      if (isFactoidPath(path)) return;
      const outcomes = events.filter((event) => OUTCOMES.has(String(event.type))).length;
      if (outcomes > 1) breaks.push(`${where}: ${outcomes} outcomes`);
      if (done !== -1 && outcomes === 0) breaks.push(`${where}: done without an outcome`);
    });
  }
  return breaks;
}
