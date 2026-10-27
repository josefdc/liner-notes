import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// A result built without the model (its factoids come from source data), then "More facts",
// which asks the model for more factoids: those must carry their own "Model inference" label.
test('factoids added by "More facts" are labelled as model inference', async ({ page }) => {
  await useMockApi(page, loadFixture("decrypt-after-model-unavailable"));
  await analyzeAndOpenDashboard(page, "Quiet Signal");
  await openPlayer(page);

  const insights = page.locator("#panel-context");
  await expect(insights).toContainText("Release Info");
  await expect(insights.getByText("From source data")).toHaveCount(1);

  await insights.getByRole("button", { name: "More facts", exact: true }).click();
  const decrypted = page.getByRole("region", { name: "More facts" });
  await expect(decrypted).toContainText("Hidden Sample");
  await expect(decrypted).toContainText("Model inference");
  await expect(decrypted).not.toContainText("From source data");
  // The lyric factoid in the stream is dropped and not counted.
  await expect(insights).not.toContainText("Lyric Meaning");
  await expect(page.getByText("1 more fact added")).toBeVisible();
});
