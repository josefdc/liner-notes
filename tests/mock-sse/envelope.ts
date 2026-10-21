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
