/**
 * @liner-notes/contract: the schemas the web app, the API and the audio service share.
 *
 * After the first release this contract changes additively only (new optional fields, new
 * schemas, wider types). `snapshot.test.ts` keeps `snapshots/` in step with the code, and
 * `npm run contract:check -- --base <ref>` fails on breaking changes against a base commit.
 */

export * from "./api.js";
export * from "./audio.js";
export * from "./audioSchema.js";
export * from "./checks.js";
export * from "./common.js";
export * from "./events.js";
export * from "./evidence.js";
export * from "./factoids.js";
export * from "./jsonSchema.js";
export * from "./llm.js";
export * from "./picker.js";
export * from "./refinements.js";
export * from "./schemas.js";
export * from "./tolerant.js";
export * from "./track.js";
