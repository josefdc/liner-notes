import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The Player's hero: each audio value with one plain label saying how it is known ("Measured from
// a 29.8 s preview"), and its confidence, basis, method and analyzer behind a "How this was
// measured" disclosure. The disclosure is closed on every visit, the keyboard reaches and opens
// it, and its details are then visible and in the accessibility tree.

const ANALYZER = "analyzer 2.1.0+essentia.models-5c5c0c7f";
const BPM_LINES =
  "Measured · estimator confidence 3.30 of 5.32, not calibrated · signal, 29.8 s preview" +
  `essentia.RhythmExtractor2013 · ${ANALYZER} · the confidence does not flag half or double tempo`;
// What the hero must not show until it is asked for.
const DETAIL = /confidence|calibrated|probability|strength|essentia|analyzer|discogs|musicnn/i;
const WHITE_COVER = "https://i.scdn.co/image/white-cover";
const WHITE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="100%" height="100%" fill="#fff"/></svg>';

/** The measured result, with a white cover (the worst case behind the hero) when asked. */
function measured(whiteCover = false) {
  const fixture = loadFixture("measured-v2");
  if (whiteCover) {
    const complete = fixture.streams["/api/analyze/stream"].find(
      (event: { type: string }) => event.type === "complete",
    );
    complete.data.coverUrl = WHITE_COVER;
  }
  return fixture;
}

async function openHero(page: Page, width: number, whiteCover = false) {
  await offline(page);
  if (whiteCover) {
    await page.route(`${WHITE_COVER}**`, (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG }),
    );
  }
  await useMockApi(page, measured(whiteCover));
  await page.setViewportSize({ width, height: 900 });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const values = page.getByRole("list", { name: "Audio values" });
  const scores = page.getByRole("list", { name: "Audio-model estimates" });
  return { values, scores, bpm: values.getByRole("listitem").filter({ hasText: /^BPM\b/ }) };
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator) {
  for (let presses = 0; !(await target.evaluate((el) => el === document.activeElement)); ) {
    presses += 1;
    expect(presses, "Tab reaches the disclosure").toBeLessThan(60);
    await page.keyboard.press("Tab");
  }
}

/** The element a disclosure button shows and hides. */
const panelOf = async (page: Page, button: Locator) =>
  page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);

type Rgb = { r: number; g: number; b: number };
const channel = (value: number) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

/**
 * WCAG contrast of an element's text against what the page draws behind it: its text and icons
 * are hidden, its box (2 px in) is screenshotted, and the brightest pixel there is the background.
 * Its text colour is read as drawn now, so a hovered or focused state is measured as it is.
 */
async function contrastOf(page: Page, element: Locator) {
  await animationsSettled(page);
  const color = await element.evaluate((el) => {
    const context = new OffscreenCanvas(1, 1).getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.fillStyle = getComputedStyle(el).color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    el.setAttribute("data-measuring", "");
    return { r, g, b, a: a / 255 };
  });
  const style = await page.addStyleTag({
    content:
      "[data-measuring],[data-measuring] *{color:transparent!important;text-decoration-color:transparent!important;transition:none!important}[data-measuring] svg{visibility:hidden!important}",
  });
  const box = await element.boundingBox();
  if (!box) throw new Error("no box to measure");
  const clip = {
    x: Math.ceil(box.x + 2),
    y: Math.ceil(box.y + 2),
    width: Math.floor(box.width - 4),
    height: Math.floor(box.height - 4),
  };
  const png = await page.screenshot({ clip, animations: "disabled" });
  await element.evaluate((el) => el.removeAttribute("data-measuring"));
  await style.evaluate((el) => (el as Element).remove());
  const background: Rgb = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let best = { r: 0, g: 0, b: 0 };
    for (let j = 0; j < data.length; j += 4) {
      if (data[j] + data[j + 1] + data[j + 2] > best.r + best.g + best.b) {
        best = { r: data[j], g: data[j + 1], b: data[j + 2] };
      }
    }
    return best;
  }, png.toString("base64"));
  const over = (c: number, bg: number) => c * color.a + bg * (1 - color.a);
  const text = {
    r: over(color.r, background.r),
    g: over(color.g, background.g),
    b: over(color.b, background.b),
  };
  const [light, dark] = [luminance(text), luminance(background)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

for (const width of [390, 1440]) {
  test(`the Player hero shows a short label and opens its details from the keyboard (${width} px)`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    const { values, scores, bpm } = await openHero(page, width);

    // One plain label per value, with the preview's real length; nothing technical shown.
    await expect(bpm).toHaveText(
      "BPM 105.2Measured from a 29.8 s previewHow this was measured (BPM)",
    );
    await expect(values.getByText("Measured from a 29.8 s preview", { exact: true })).toHaveCount(
      3,
    );
    await expect(
      scores.getByText("Estimated by an audio model from a 29.8 s preview", { exact: true }),
    ).toHaveCount(5);
    await expect(scores).not.toContainText("Measured");
    for (const list of [values, scores]) {
      await expect(list).not.toContainText(DETAIL);
      expect(await list.ariaSnapshot()).not.toMatch(DETAIL);
    }

    // Tab reaches the disclosure, which is announced as a closed button named for its value.
    const how = bpm.getByRole("button", { name: "How this was measured (BPM)" });
    await expect(how).toHaveAttribute("aria-expanded", "false");
    const panel = await panelOf(page, how);
    await expect(panel).toBeHidden();
    await tabTo(page, how);
    expect(await how.evaluate((el) => el.matches(":focus-visible"))).toBe(true);

    // Enter opens it: every detail is visible and in the accessibility tree.
    await page.keyboard.press("Enter");
    await expect(how).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveText(BPM_LINES);
    const tree = await values.ariaSnapshot();
    for (const detail of [
      "estimator confidence 3.30 of 5.32, not calibrated",
      "signal, 29.8 s preview",
      "essentia.RhythmExtractor2013",
      ANALYZER,
    ]) {
      expect(tree).toContain(detail);
    }
    expect(tree).toMatch(/button "How this was measured \(BPM\)" \[expanded\]/);

    // Space closes it and opens it again.
    await page.keyboard.press("Space");
    await expect(how).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    expect(await values.ariaSnapshot()).not.toMatch(DETAIL);
    await page.keyboard.press("Space");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveText(BPM_LINES);

    // An estimate's disclosure never calls it measured.
    const dance = scores.getByRole("button", { name: "How this was estimated (Dance)" });
    await dance.click();
    await expect(await panelOf(page, dance)).toHaveText(
      `Model estimate · score, not a probability · model discogs-effnet-bs64-1, 29.8 s preview${ANALYZER}`,
    );

    // The open state is not kept: back on the summary and into the Player again, it is closed.
    await page.getByRole("button", { name: /Back to summary/ }).click();
    await openPlayer(page);
    await expect(
      page
        .getByRole("list", { name: "Audio values" })
        .getByRole("button", { name: "How this was measured (BPM)" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(problems).toEqual([]);
  });

  test(`the Player hero does not overflow, with every disclosure open (${width} px)`, async ({
    page,
  }) => {
    const { values, scores } = await openHero(page, width);
    const closed = page
      .locator("#panel-player")
      .getByRole("button", { name: /^How this was|^Why this|^About this/, expanded: false });
    for (let left = await closed.count(); left > 0; left -= 1) await closed.first().click();
    await expect(closed).toHaveCount(0);
    await animationsSettled(page);

    const overflow = await page.locator("#panel-player").evaluate((panel) => {
      const column = panel.getBoundingClientRect();
      const lists = panel.querySelectorAll(
        '[aria-label="Audio values"], [aria-label="Audio-model estimates"]',
      );
      const outside: string[] = [];
      for (const list of lists) {
        for (const element of list.querySelectorAll("*")) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (element.closest(".sr-only")) continue;
          if (box.left < column.left - 0.5 || box.right > column.right + 0.5) {
            outside.push((element.textContent ?? element.tagName).slice(0, 40));
          }
        }
      }
      return {
        outside,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panel: panel.scrollWidth - panel.clientWidth,
      };
    });
    expect(overflow).toEqual({ outside: [], page: 0, panel: 0 });
    // Every value's details are shown, at once.
    await expect(values.getByText(/^Measured · /)).toHaveCount(3);
    await expect(scores.getByText(/^Model estimate · /)).toHaveCount(5);
  });
}

for (const cover of ["no cover", "a white cover"]) {
  test(`the hero's label and disclosure are 12 px or more and meet 4.5:1 at rest and on focus (${cover})`, async ({
    page,
  }) => {
    const { bpm, scores } = await openHero(page, 1440, cover === "a white cover");
    if (cover === "a white cover") {
      await expect
        .poll(() =>
          page.evaluate(
            (src) =>
              [...document.images].filter(
                (image) =>
                  image.currentSrc.startsWith(src) && image.complete && image.naturalWidth > 0,
              ).length,
            WHITE_COVER,
          ),
        )
        .toBeGreaterThan(0);
    }
    const dance = scores.getByRole("listitem").filter({ hasText: /^Dance\b/ });
    const parts = [
      bpm.getByText("Measured from a 29.8 s preview", { exact: true }),
      bpm.getByRole("button", { name: "How this was measured (BPM)" }),
      dance.getByText("Estimated by an audio model from a 29.8 s preview", { exact: true }),
      dance.getByRole("button", { name: "How this was estimated (Dance)" }),
    ];
    await page.mouse.move(0, 0);
    for (const part of parts) {
      const size = await part.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(12);
      expect(await contrastOf(page, part), "at rest").toBeGreaterThanOrEqual(4.5);
    }
    for (const button of [parts[1], parts[3]]) {
      await tabTo(page, button);
      expect(await button.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
      expect(await contrastOf(page, button), "on focus").toBeGreaterThanOrEqual(4.5);
    }
  });
}
