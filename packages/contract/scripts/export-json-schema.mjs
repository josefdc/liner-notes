// Writes dist/audio-features.schema.json (run by `npm run build` after tsc): the JSON Schema the
// audio service validates its output against. The same file is committed as
// schemas/audio-features.schema.json, kept up to date by the snapshot test.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { audioFeaturesJsonSchema } = await import(join(dist, "index.js"));

writeFileSync(
  join(dist, "audio-features.schema.json"),
  `${JSON.stringify(audioFeaturesJsonSchema(), null, 2)}\n`,
);
console.log("wrote dist/audio-features.schema.json");
