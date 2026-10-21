// Preloaded (node --import) into processes that tests start: replaces fetch so nothing reaches
// the network. With FAKE_PROVIDER=answer, requests to the fake endpoint (https://llm.invalid/)
// get a Responses API answer `{"ok":true}`; every other request, and every request without
// FAKE_PROVIDER=answer, is refused and reported on stderr as NETWORK-ATTEMPT.
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (process.env.FAKE_PROVIDER === "answer" && url.startsWith("https://llm.invalid/")) {
    return Response.json({
      id: "resp_fake",
      object: "response",
      created_at: 1760000000,
      status: "completed",
      model: "fake",
      output: [
        {
          type: "message",
          id: "msg_fake",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 70,
      },
    });
  }
  process.stderr.write("NETWORK-ATTEMPT\n");
  throw new Error("network denied in tests");
};
