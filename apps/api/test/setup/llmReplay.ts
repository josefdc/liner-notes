// Model calls in tests are replayed from cassettes unless a test chooses otherwise: with
// LLM_CASSETTE=replay the provider layer never builds a live client, so a test cannot reach a
// paid model or spend from the shared budget by accident. A cassette miss is an error. An
// empty or "off" value exported in the shell is overridden too; a test that needs live mode
// passes its own settings.
//
// The deployments are pinned to the defaults: a cassette's key includes the deployment, so
// recording and replaying must use the same tier-to-deployment map whatever a developer's
// shell exports.
import { DEFAULT_DEPLOYMENTS, deploymentVariable, LLM_TIERS } from "../../src/config/settings.js";

if (!process.env.LLM_CASSETTE?.trim() || process.env.LLM_CASSETTE.trim() === "off") {
  process.env.LLM_CASSETTE = "replay";
}
for (const tier of LLM_TIERS) process.env[deploymentVariable(tier)] = DEFAULT_DEPLOYMENTS[tier];
delete process.env.AZURE_OPENAI_DEPLOYMENT_PRO;
