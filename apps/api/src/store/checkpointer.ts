/**
 * The graph's checkpointer: LangGraph's SQLite saver, without preview URLs.
 *
 * Preview clip URLs are signed and expire within minutes (Deezer's carry an `hdnea` token), so
 * a saved one is never of use later and must not be kept. The run's own clip lives in memory
 * while the run goes on (the engineer writes it, the composer sends it); what is saved of the
 * channels that can hold one has it removed: the `previewUrl` channel is saved as null,
 * `previewUrl` fields and preview URLs elsewhere in the track data are dropped (as in stored
 * results, store/runs.ts), and a preview URL inside a longer text (an error message) is cut
 * out. The same goes for the clarification's interrupt payload (the candidates offered). A run
 * resumed from a checkpoint therefore has no clip until a node looks one up again, which is
 * what the clarification and the engineer do.
 */

import { INTERRUPT } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { withoutPreviewUrls } from "./runs.js";

// A preview clip URL inside a longer text.
const PREVIEW_IN_TEXT = /https?:\/\/(?:[^\s"'<>/]*\.)?(?:dzcdn\.net|p\.scdn\.co)[^\s"'<>]*/gi;

/** `value` without preview URLs: as withoutPreviewUrls, and with those inside texts cut out. */
function scrubbed(value: unknown): unknown {
  const cut = (inner: unknown): unknown => {
    if (typeof inner === "string") return inner.replace(PREVIEW_IN_TEXT, "[preview]");
    if (Array.isArray(inner)) return inner.map(cut);
    if (inner === null || typeof inner !== "object") return inner;
    return Object.fromEntries(Object.entries(inner).map(([key, field]) => [key, cut(field)]));
  };
  return cut(withoutPreviewUrls(value));
}

/** The state channels that can hold a preview URL, and their saved form. */
const PREVIEW_CHANNELS = new Map<string, (value: unknown) => unknown>([
  ["previewUrl", () => null],
  ["spotifyData", scrubbed],
  ["candidates", scrubbed],
  ["trackData", scrubbed],
  ["audioFeatures", scrubbed],
]);

/**
 * An interrupt write: an interrupt (or a list of them) whose `value` is the payload, here the
 * candidates offered. Each interrupt keeps its own kind; only its payload is scrubbed.
 */
function scrubbedInterrupts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubbedInterrupts);
  if (value === null || typeof value !== "object" || !("value" in value)) return value;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(value)), value);
  copy.value = scrubbed(value.value);
  return copy;
}

/** The value as it may be saved for `channel`. Other channels are saved as they are. */
function saved(channel: string, value: unknown): unknown {
  if (channel === INTERRUPT) return scrubbedInterrupts(value);
  const strip = PREVIEW_CHANNELS.get(channel);
  return strip && value != null ? strip(value) : value;
}

type PutArgs = Parameters<SqliteSaver["put"]>;
type PutWritesArgs = Parameters<SqliteSaver["putWrites"]>;

export class PreviewFreeSqliteSaver extends SqliteSaver {
  // Every argument after the checkpoint is passed on as given (the base saver's interface also
  // has `newVersions`, which this version of the SQLite saver does not declare).
  override async put(...args: PutArgs) {
    const [config, checkpoint, ...rest] = args as unknown[] as [
      PutArgs[0],
      PutArgs[1],
      ...unknown[],
    ];
    const values = Object.fromEntries(
      Object.entries(checkpoint.channel_values).map(([channel, value]) => [
        channel,
        saved(channel, value),
      ]),
    );
    const basePut = super.put as (...forwarded: unknown[]) => ReturnType<SqliteSaver["put"]>;
    return basePut.call(this, config, { ...checkpoint, channel_values: values }, ...rest);
  }

  override async putWrites(...[config, writes, taskId]: PutWritesArgs) {
    return super.putWrites(
      config,
      writes.map(([channel, value]) => [channel, saved(channel, value)]),
      taskId,
    );
  }
}
