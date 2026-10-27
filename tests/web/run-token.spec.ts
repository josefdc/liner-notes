import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  runTokens,
  useMockApi,
} from "./mock";

// Every analysis, resume and factoid request carries a run token (POST /api/runs): the mocked
// API refuses a stream without one of its tokens, as the API does.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const MORE = "/api/factoids/more/stream";

test("an analysis asks for a run token first, and its facts reuse it", async ({ page }) => {
  const problems = collectProblems(page);
  const fixture = loadFixture("full-result");
  await useMockApi(page, {
    ...fixture,
    streams: {
      ...fixture.streams,
      [MORE]: [{ type: "connected", nextRound: 1, roundsLeft: true }, { type: "done" }],
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await page
    .locator("#panel-context")
    .getByRole("button", { name: "Find more facts", exact: true })
    .click();
  await expect.poll(async () => (await apiRequests(page)).some((r) => r.includes(MORE))).toBe(true);

  const requests = await apiRequests(page);
  const asked = requests.filter(
    (entry) => entry === "fetch /api/runs" || entry.startsWith("stream "),
  );
  expect(asked.map((entry) => entry.split("?")[0])).toEqual([
    "fetch /api/runs",
    `stream ${ANALYZE}`,
    `stream ${MORE}`,
  ]);
  expect(await runTokens(page)).toEqual({ issued: ["mock-run-token-1"], refused: [] });
  expect(problems).toEqual([]);
});

test("a pick resumes with the analysis's own token", async ({ page }) => {
  const problems = collectProblems(page);
  const fixture = loadFixture("hitl");
  await useMockApi(page, fixture);
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("option").first().click();
  await expect
    .poll(async () => (await apiRequests(page)).some((r) => r.startsWith(`stream ${RESUME}?`)))
    .toBe(true);

  expect((await apiRequests(page)).filter((entry) => entry === "fetch /api/runs")).toHaveLength(1);
  expect(await runTokens(page)).toEqual({ issued: ["mock-run-token-1"], refused: [] });
  expect(problems).toEqual([]);
});
