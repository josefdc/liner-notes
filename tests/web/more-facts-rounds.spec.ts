import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  streamLog,
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
            { type: "connected", nextRound: 1, roundsLeft: true },
            fact("fc-aaaaaaaaaaaa", "Tape Echo"),
            { type: "done" },
          ],
          [
            { type: "connected", nextRound: 2, roundsLeft: false },
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
  const more = insights.getByRole("button", { name: "Find more facts", exact: true });
  await more.click();
  await expect(insights).toContainText("Tape Echo");
  await expect(more).toBeEnabled();
  await more.click();
  // Three cards show at first; the second round's fact is behind the reveal control.
  await insights.getByRole("button", { name: /^Show 1 more fact$/ }).click();
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
  // Still disabled with its reason once the answers have settled, and nothing more was asked.
  await expect(more).toBeDisabled();
  await expect(more).toHaveAttribute("aria-describedby", (await reason.getAttribute("id")) ?? "");
  expect(await streamLog(page)).not.toContain(`${MORE} reconnect`);
  expect((await apiRequests(page)).filter((entry) => entry.includes("/factoids/"))).toHaveLength(2);
  expect(problems).toEqual([]);
});

test("a click whose every fact failed does not use up its round", async ({ page }) => {
  const problems = collectProblems(page);
  const allFailed = (nextRound: number) => [
    { type: "connected", nextRound, roundsLeft: nextRound < 2 },
    ...[0, 1, 2].map((index) => ({
      type: "error",
      code: "failed",
      error: "This fact could not be generated.",
      index,
    })),
    { type: "done" },
  ];
  await useMockApi(page, {
    ...fixture,
    streams: {
      "/api/analyze/stream": withRun(fixture.streams["/api/analyze/stream"]),
      [MORE]: { opens: [allFailed(1), allFailed(2)] },
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const insights = page.locator("#panel-context");
  const more = insights.getByRole("button", { name: "Find more facts", exact: true });
  await more.click();
  await expect(insights).toContainText("3 facts could not be written.");
  await expect(more).toBeEnabled();
  await more.click();
  await expect
    .poll(async () => (await streamLog(page)).filter((e) => e === `${MORE} done`))
    .toHaveLength(2);
  await expect(more).toBeEnabled();
  await expect(insights).toContainText("3 facts could not be written.");
  await expect(insights).not.toContainText("No more facts");

  const rounds = (await apiRequests(page))
    .filter((entry) => entry.startsWith(`stream ${MORE}?`))
    .map((entry) => new URLSearchParams(entry.slice(entry.indexOf("?") + 1)).get("round"));
  expect(rounds).toEqual(["0", "0"]);
  expect(problems).toEqual([]);
});

test("a round asked again asks only the angles that failed, and shows each fact once", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const at = (id: string, title: string, index: number) => ({ ...fact(id, title), index });
  const busy = (index: number) => ({ type: "error", code: "rate_limited", error: "Busy.", index });
  await useMockApi(page, {
    ...fixture,
    streams: {
      "/api/analyze/stream": withRun(fixture.streams["/api/analyze/stream"]),
      [MORE]: {
        opens: [
          [
            { type: "connected", nextRound: 1, roundsLeft: true },
            at("fc-aaaaaaaaaaaa", "Angle Zero", 0),
            busy(1),
            busy(2),
            { type: "done" },
          ],
          [
            { type: "connected", nextRound: 1, roundsLeft: true },
            at("fc-bbbbbbbbbbbb", "Angle One", 1),
            busy(2),
            { type: "done" },
          ],
          [
            { type: "connected", nextRound: 1, roundsLeft: true },
            at("fc-cccccccccccc", "Angle Two", 2),
            { type: "done" },
          ],
          [{ type: "connected", nextRound: 2, roundsLeft: false }, { type: "done" }],
        ],
      },
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const insights = page.locator("#panel-context");
  const more = insights.getByRole("button", { name: "Find more facts", exact: true });
  // The rate limit is said as such while an angle waits on it; the facts written are kept.
  for (const [click, busyNow] of [
    [1, true],
    [2, true],
    [3, false],
    [4, false],
  ] as const) {
    await expect(more).toBeEnabled();
    await more.click();
    await expect
      .poll(async () => (await streamLog(page)).filter((e) => e === `${MORE} done`))
      .toHaveLength(click);
    if (busyNow) await expect(insights).toContainText("More facts unavailable");
    else await expect(insights).not.toContainText("More facts unavailable");
  }
  const reveal = insights.getByRole("button", { name: /^Show \d+ more facts?$/ });
  if (await reveal.count()) await reveal.click();

  // The round's three facts, each once, in the order of their angles.
  const text = await insights.innerText();
  const titles = ["Angle Zero", "Angle One", "Angle Two"];
  expect(titles.map((title) => text.split(title).length - 1)).toEqual([1, 1, 1]);
  const order = titles.map((title) => text.indexOf(title));
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  const asked = (await apiRequests(page))
    .filter((entry) => entry.startsWith(`stream ${MORE}?`))
    .map((entry) => new URLSearchParams(entry.slice(entry.indexOf("?") + 1)));
  expect(asked.map((query) => [query.get("round"), query.get("failedIndexes")])).toEqual([
    ["0", null],
    ["0", "1,2"],
    ["0", "2"],
    ["1", null],
  ]);
  expect(problems).toEqual([]);
});
