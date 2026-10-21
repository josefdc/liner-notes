import { expect, type Locator, type Page } from "@playwright/test";

// Hovering a connected-track card reliably. The card sits below the fold at 1440x900, and the
// app focuses the Dashboard heading a frame or two after the Dashboard mounts, which scrolls the
// page back to the top. On a slow machine that can happen after a test has scrolled the card into
// view and placed the pointer on it, moving the card away from the pointer.

type Box = { x: number; y: number; width: number; height: number };

/**
 * Scrolls the Dashboard (not the window) so that `target` starts a quarter of the way down the
 * viewport, then waits until its box has stayed the same for several animation frames.
 */
export async function placeInDashboard(target: Locator): Promise<Box> {
  return target.evaluate(
    (element) =>
      new Promise<Box>((resolve, reject) => {
        const page = element.closest(".overflow-y-auto");
        if (page) page.scrollTop += element.getBoundingClientRect().top - page.clientHeight / 4;
        let last = "";
        let same = 0;
        const started = performance.now();
        const check = () => {
          const rect = element.getBoundingClientRect();
          const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
          same = key === last ? same + 1 : 0;
          last = key;
          if (same >= 5) {
            resolve({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          } else if (performance.now() - started > 3000) {
            reject(new Error(`the element kept moving (last box ${key})`));
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      }),
  );
}

/**
 * Puts the pointer on `card` at the point `at(box)` (default: its centre) and waits until the
 * app reports the hover (`data-hovered`). Placing the card and the pointer is retried if the page
 * scrolls under it; the assertions that follow are not retried.
 */
export async function hoverCard(
  page: Page,
  card: Locator,
  at: (box: Box) => { x: number; y: number } = (box) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  }),
): Promise<{ box: Box; point: { x: number; y: number } }> {
  let result: { box: Box; point: { x: number; y: number } } | undefined;
  await expect(async () => {
    // Measure the card at rest, with the pointer away from it.
    await page.mouse.move(0, 0);
    await expect(card).not.toHaveAttribute("data-hovered", "true");
    const box = await placeInDashboard(card);
    const point = at(box);
    await page.mouse.move(point.x, point.y);
    await expect(card).toHaveAttribute("data-hovered", "true", { timeout: 2000 });
    result = { box, point };
  }).toPass({ timeout: 20_000 });
  if (!result) throw new Error("the card was not hovered");
  return result;
}
