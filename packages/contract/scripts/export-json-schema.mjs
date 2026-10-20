// Writes the JSON Schemas other languages read into dist/ (run by `npm run build` after tsc):
// dist/audio-features.schema.json, which the audio service's tests validate its output against.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { AudioFeatures, AUDIO_FEATURES_VERSION, toJsonSchema } = await import(
  join(dist, "index.js")
);

const schema = {
  ...toJsonSchema(AudioFeatures),
  title: "AudioFeatures",
  description: `AudioFeatures v${AUDIO_FEATURES_VERSION}, generated from @liner-notes/contract`,
};
const target = join(dist, "audio-features.schema.json");
writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
console.log("wrote dist/audio-features.schema.json");
