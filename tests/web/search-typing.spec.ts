import { expect, type Locator, type Page, test } from "@playwright/test";
import { useMockApi } from "./mock";

// Typing at full speed while suggestions come and go: the box keeps exactly what was typed, and
// the list ends with the suggestions for the whole text, whatever order the answers arrive in.
// The mocked API answers each query with suggestions made from its own text, after a delay that
// varies from one answer to the next, so an answer for older text would show.
const PHRASE = "One More Time Daft Punk";
const FIRST_PART = "One More";
const REPEATS = 20;
// How long typing pauses after the first part: past the 300 ms before suggestions are asked for
// in some rounds, so a request for the first part is often still answering while the rest is
// typed.
const PAUSES_MS = [0, 150, 350, 500];
// The mock's longest answer delay, and the wait after the list shows the whole text before it is
// checked again (any older answer has arrived by then).
const JITTER_MS = 600;

type Typist = (page: Page, input: Locator, text: string, previous: string) => Promise<void>;

const modes: Array<[string, Typist, number]> = [
  [
    "keyboard.type",
    async (page, input, text, previous) => {
      await input.focus();
      await page.keyboard.type(text.slice(previous.length));
    },
    11,
  ],
  [
    "pressSequentially",
    async (_page, input, text, previous) => {
      await input.pressSequentially(text.slice(previous.length));
    },
    23,
  ],
  [
    "fill",
    async (_page, input, text) => {
      await input.fill(text);
    },
    37,
  ],
];

/** The text of each suggestion shown: its title, then its artist and album. */
const optionTitles = (page: Page) =>
  page
    .getByRole("listbox")
    .getByRole("option")
    .evaluateAll((options) => options.map((option) => option.textContent ?? ""));

const showsWholeText = (titles: string[]) =>
  titles.length === 3 && titles.every((title) => title.startsWith(PHRASE));

for (const [name, type, seed] of modes) {
  test(`typing "${PHRASE}" with ${name} keeps the exact text, ${REPEATS} times`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await useMockApi(page, {
      suggestions: [],
      streams: {},
      suggestEcho: true,
      suggestJitter: { maxMs: JITTER_MS, seed },
    });
    await page.goto("/");
    const input = page.getByRole("combobox", { name: "Song title and artist" });

    for (let round = 0; round < REPEATS; round++) {
      await input.fill("");
      await type(page, input, FIRST_PART, "");
      await page.waitForTimeout(PAUSES_MS[round % PAUSES_MS.length]);
      await type(page, input, PHRASE, FIRST_PART);
      // A box whose text reaches its state late (a deferred or throttled update) drops or
      // reorders keystrokes here.
      expect(await input.inputValue(), `round ${round + 1}, as typed`).toBe(PHRASE);

      // The list ends on the whole text, and stays there once every answer is in: an answer for
      // older text that is shown (no abort, no check of which request it answers) fails here.
      await expect.poll(() => optionTitles(page).then(showsWholeText)).toBe(true);
      await page.waitForTimeout(JITTER_MS + 100);
      expect(showsWholeText(await optionTitles(page)), `round ${round + 1}, list`).toBe(true);
      expect(await input.inputValue(), `round ${round + 1}, after the answers`).toBe(PHRASE);
    }
  });
}
