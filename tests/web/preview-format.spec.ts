import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// A result whose preview the audio service refused for what the file is (an M4A, or an MP3 that
// does not decode in full): nothing measured, and the reason said as what the file is, never as
// a failed analysis.
const missing = loadFixture("missing-states");

/** The missing-states result, its audio unavailable for `reason`. */
function withAudioReason(reason: string) {
  const fixture = structuredClone(missing);
  for (const stream of Object.values(fixture.streams) as Array<
    Array<{ type: string; data?: Record<string, unknown> }>
  >) {
    for (const event of stream) {
      if (event.type === "complete" && event.data) event.data.audioUnavailableReason = reason;
    }
  }
  return fixture;
}

for (const [reason, sentence] of [
  ["unsupported_format", "The preview is in a format the service does not measure."],
  ["decode_incomplete", "The preview does not decode to its full length, so it was not measured."],
] as const) {
  test(`the Dashboard and the Player say the preview kept the audio from being measured (${reason})`, async ({
    page,
  }) => {
    await useMockApi(page, withAudioReason(reason));
    await analyzeAndOpenDashboard(page, "Quiet Signal");

    const notices = page.getByRole("region", { name: "Missing data" });
    await expect(notices).toContainText("Audio not analyzed");
    await expect(notices).toContainText(sentence);
    await expect(page.locator("#root")).not.toContainText(/analysis failed/i);
    const stats = page.getByRole("list", { name: "Audio values" });
    await expect(stats).toContainText("BPM not measured");
    await expect(stats).toContainText("Key not measured");
    // Same line only: the album's year on the line above "BPM not measured" is not a tempo.
    expect(await page.locator("#root").innerText()).not.toMatch(/\d[ \t]*BPM/);

    await openPlayer(page);
    await expect(page.getByRole("region", { name: "Missing data" })).toContainText(sentence);
    await expect(page.locator("#root")).not.toContainText(/analysis failed/i);
  });
}
