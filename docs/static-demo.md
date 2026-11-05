# The static demo

The [live demo](https://josefdc.github.io/liner-notes/) is the web app with no server behind it. It
replays the five [showcase](evaluation.md#the-showcase) recordings in the browser: no API, no keys,
no model calls. It says so on the first page, and every result says "Recorded run".

## How it works

`npm run demo:build` (`scripts/build-static-demo.mjs`):

1. Builds the web app with `VITE_STATIC_DEMO=1`, under the path of `--site`.
2. Starts the real API with `REPLAY_MODE=only`, dummy keys and outbound network denied, and keeps
   what it answers for each recording: the analysis stream, the stored result, the "More facts"
   stream, and its refusal of any other song.
3. Writes those answers to `demo-data/`, and one page per address with its own metadata.

In the browser, `apps/web/src/demo/staticApi.ts` answers the app's `/api` requests from those files,
replacing `fetch` and `EventSource` for `/api` only. The app's own code paths run unchanged, and other
builds leave the demo's code out.

## What search engines and link previews read

Each address (`/`, `/t/<id>/`, `/t/<id>/map/`) is a real file with its own title, description,
canonical address, Open Graph and Twitter tags, JSON-LD (`MusicRecording`, or `SoftwareSourceCode` on
the first page), and a plain article with the page's relations, claims and sources, which the app
replaces when it starts. Everything comes from the recorded result, and the article stays readable
without JavaScript. `sitemap.xml` lists every address.

There is no `robots.txt`: a crawler reads one only at a host's root, which a project's GitHub Pages
site does not own. Submit `sitemap.xml` in
[Google Search Console](https://search.google.com/search-console) instead.

## Build and host your own

```bash
npm ci
npm run demo:build -- --site https://you.github.io/liner-notes
npm run demo:preview    # serves it as GitHub Pages does, at http://127.0.0.1:4173/liner-notes/
```

Any static host works. `.github/workflows/pages.yml` deploys to GitHub Pages on each push to `main`
that changes the app or a recording, once the repository's Pages source is set to "GitHub Actions".

After a recording changes, run `npm run demo:cards` for the link previews and the repository's social
preview (`docs/images/social-preview.png`, uploaded by hand in the repository's settings), and
`node scripts/demo-gif.mjs` for the README's animation.
