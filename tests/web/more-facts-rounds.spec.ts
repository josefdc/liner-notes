import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// "More facts" are asked for in rounds: each click sends the result's run id and the round the
// last answer named, and once every round has been asked the control says so and asks no more.
const MORE = "/api/factoids/more/stream";
const RUN = "thread-full";
const fixture = loadFixture("full-result");
const withRun = (events: Array<{ type: string; data?: object }>) =>
  events.map((event) =>
    event.type === "complete"
      ? {
          ...event,
          data: {
            ...event.data,
            run: { id: RUN, mode: "live", recordedAt: null, commit: null, analyzerVersion: null },
          },
        }
      : event,
  );
const fact = (id: string, title: string) => ({
  type: "factoid",
  data: { id, title, content: `${title}, as the run's sources say.`, type: "production" },
});

test("two clicks ask for two rounds with the run id, then the control says there are no more", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    ...fixture,
    streams: {
      "/api/analyze/stream": withRun(fixture.streams["/api/analyze/stream"]),
      [MORE]: {
        opens: [
          [
            { type: "connected", nextRound: 1 },
            fact("fc-aaaaaaaaaaaa", "Tape Echo"),
            { type: "done" },
          ],
          [
            { type: "connected", nextRound: 2 },
            fact("fc-bbbbbbbbbbbb", "Night Session"),
            { type: "done" },
          ],
        ],
      },
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const insights = page.locator("#panel-context");
  const more = insights.getByRole("button", { name: /DECRYPT MORE/ });
  await more.click();
  await expect(insights).toContainText("Tape Echo");
  await expect(more).toBeEnabled();
  await more.click();
  // Three cards show at first; the second round's fact is behind the reveal control.
  await insights.getByRole("button", { name: /Reveal 1 hidden/ }).click();
  await expect(insights).toContainText("Night Session");

  const reason = insights.getByText("No more facts: every angle on this track has been asked.");
  await expect(reason).toBeVisible();
  await expect(more).toBeDisabled();
  await expect(more).toHaveAccessibleDescription(
    "No more facts: every angle on this track has been asked.",
  );

  const asked = (await apiRequests(page))
    .filter((entry) => entry.startsWith(`stream ${MORE}?`))
    .map((entry) => new URLSearchParams(entry.slice(entry.indexOf("?") + 1)));
  expect(asked.map((query) => [query.get("round"), query.get("runId")])).toEqual([
    ["0", RUN],
    ["1", RUN],
  ]);
  expect(asked[1].get("existingIds")).toBe("f1,f2,fc-aaaaaaaaaaaa");

  // A click on the disabled control asks for nothing.
  await more.click({ force: true });
  expect(
    (await apiRequests(page)).filter((entry) => entry.startsWith(`stream ${MORE}?`)),
  ).toHaveLength(2);
  expect(problems).toEqual([]);
});
