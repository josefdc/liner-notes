import type { Page } from "@playwright/test";

/** An empty picture: what an outside image (a recorded result's cover) is answered with. */
export const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';

/**
 * Keeps a page off the network: every request to another host than the app's own is answered
 * here. A picture (a recorded result's Cover Art Archive cover) is an empty image; anything else
 * is refused.
 */
export async function offline(page: Page) {
  await page.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) =>
      route.request().resourceType() === "image"
        ? route.fulfill({ contentType: "image/svg+xml", body: EMPTY_SVG })
        : route.abort(),
  );
}
