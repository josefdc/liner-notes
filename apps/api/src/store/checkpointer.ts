/**
 * The graph's checkpointer: LangGraph's SQLite saver, without preview URLs.
 *
 * Preview clip URLs are signed and expire within minutes (Deezer's carry an `hdnea` token), so
 * a saved one is never of use later and must not be kept. The run's own clip lives in memory
 * while the run goes on (the engineer writes it, the composer sends it); what is saved of the
 * channels that can hold one has it removed: the `previewUrl` channel is saved as null, and
 * `previewUrl` fields and preview URLs elsewhere in the track data are dropped (as in stored
 * results, store/runs.ts). A run resumed from a checkpoint therefore has no clip until a node
 * looks one up again, which is what the clarification and the engineer do.
 */

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { withoutPreviewUrls } from "./runs.js";

/** The state channels that can hold a preview URL, and their saved form. */
const PREVIEW_CHANNELS = new Map<string, (value: unknown) => unknown>([
  ["previewUrl", () => null],
  ["spotifyData", withoutPreviewUrls],
  ["candidates", withoutPreviewUrls],
  ["trackData", withoutPreviewUrls],
]);

/** The value as it may be saved for `channel`. Other channels are saved as they are. */
function saved(channel: string, value: unknown): unknown {
  const strip = PREVIEW_CHANNELS.get(channel);
  return strip && value != null ? strip(value) : value;
}

type PutArgs = Parameters<SqliteSaver["put"]>;
type PutWritesArgs = Parameters<SqliteSaver["putWrites"]>;

export class PreviewFreeSqliteSaver extends SqliteSaver {
  override async put(...[config, checkpoint, metadata]: PutArgs) {
    const values = Object.fromEntries(
      Object.entries(checkpoint.channel_values).map(([channel, value]) => [
        channel,
        saved(channel, value),
      ]),
    );
    return super.put(config, { ...checkpoint, channel_values: values }, metadata);
  }

  override async putWrites(...[config, writes, taskId]: PutWritesArgs) {
    return super.putWrites(
      config,
      writes.map(([channel, value]) => [channel, saved(channel, value)]),
      taskId,
    );
  }
}
