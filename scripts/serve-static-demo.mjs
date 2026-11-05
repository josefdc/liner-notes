#!/usr/bin/env node
// Serves the static demo's build as GitHub Pages does: under its path, an address's own index.html,
// and 404.html for an address that holds no file.
//
//   node scripts/serve-static-demo.mjs [--dir apps/web/dist-demo] [--base /liner-notes/] [--port 4173]

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

/** The file an address holds under `dir`, or null. Never a file outside `dir`. */
export function fileFor(dir, base, pathname) {
  if (!pathname.startsWith(base)) return null;
  const candidate = resolve(dir, `.${decodeURI(pathname).slice(base.length - 1)}`);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  if (!existsSync(candidate)) return null;
  if (statSync(candidate).isFile()) return candidate;
  const index = join(candidate, "index.html");
  return existsSync(index) ? index : null;
}

/** Starts the server; resolves with its address. */
export function serveDemo({ dir, base = "/liner-notes/", port = 4173 }) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    const file = fileFor(dir, base, pathname);
    const shown = file ?? join(dir, "404.html");
    response.writeHead(file ? 200 : 404, {
      "Content-Type": TYPES[extname(shown)] ?? "application/octet-stream",
    });
    createReadStream(shown).pipe(response);
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => {
      done({ server, url: `http://127.0.0.1:${server.address().port}${base}` });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: "apps/web/dist-demo" },
      base: { type: "string", default: "/liner-notes/" },
      port: { type: "string", default: "4173" },
    },
  });
  const dir = resolve(ROOT, values.dir);
  if (!existsSync(join(dir, "index.html"))) {
    console.error(`No build in ${dir}: run npm run demo:build first.`);
    process.exit(1);
  }
  const { url } = await serveDemo({ dir, base: values.base, port: Number(values.port) });
  console.log(`The static demo is at ${url}`);
}
