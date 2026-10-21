// Model calls in tests are replayed from cassettes unless a test chooses otherwise: with
// LLM_CASSETTE=replay the provider layer never builds a live client, so a test cannot reach a
// paid model or spend from the shared budget by accident. A cassette miss is an error. An
// empty or "off" value exported in the shell is overridden too; a test that needs live mode
// passes its own settings.
if (!process.env.LLM_CASSETTE?.trim() || process.env.LLM_CASSETTE.trim() === "off") {
  process.env.LLM_CASSETTE = "replay";
}
