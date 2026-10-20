/**
 * The JSON Schema the audio service validates its own output against.
 *
 * It is the AudioFeatures schema plus the gate rule, which zod states as a producer-side check
 * (`audioFeaturesIssues`) so that readers stay tolerant (a cross-reference violation or an
 * unknown value never rejects a result): a gate that did not pass has a reason,
 * every measured block null and no key moments; a gate that passed has no reason. The file is
 * committed as `packages/contract/schemas/audio-features.schema.json` (a test keeps it up to
 * date) so the service's tests can read it without Node.
 */

import { AUDIO_FEATURES_VERSION, AUDIO_MEASURED_BLOCKS, AudioFeatures } from "./audio.js";
import { type JsonSchema, toJsonSchema } from "./jsonSchema.js";

const gate = (passed: boolean) => ({
  properties: { gate: { properties: { passed: { const: passed } }, required: ["passed"] } },
  required: ["gate"],
});

export function audioFeaturesJsonSchema(): JsonSchema {
  const nulls = Object.fromEntries(AUDIO_MEASURED_BLOCKS.map((block) => [block, { type: "null" }]));
  return {
    ...toJsonSchema(AudioFeatures),
    title: "AudioFeatures",
    description: `AudioFeatures v${AUDIO_FEATURES_VERSION}, generated from @liner-notes/contract`,
    allOf: [
      {
        if: gate(false),
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: {
          properties: {
            gate: { properties: { reason: { type: "string" } } },
            ...nulls,
            keyMoments: { maxItems: 0 },
          },
        },
      },
      {
        if: gate(true),
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
        then: { properties: { gate: { properties: { reason: { type: "null" } } } } },
      },
    ],
  };
}
