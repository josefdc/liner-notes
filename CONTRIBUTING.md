# Contributing to Liner Notes

Thanks for your interest. Bug reports, failure cases and focused pull requests are all welcome.

## Good first contributions

- **A wrong result.** A song where the page states something false, or misses a documented sample,
  is the most useful report there is. Say the song, what the page showed and what source says
  otherwise.
- **A new source.** Sources live in `apps/api/src/sources`. Each one states its terms in `NOTICE`.
- **The [known limitations](docs/limitations.md).** Many are small and well described.

Open an issue before a large change, so we can agree on the approach first.

## Setting up

[Development](docs/development.md) has the full setup. With no API keys, you can work on the web app
and the API against the recorded runs:

```bash
npm ci
DEV_SERVICES=web,api REPLAY_MODE=only npm run dev
```

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run check:links     # when you touch Markdown
```

CI runs these and more on every pull request ([the full list](docs/development.md#4-checks)). A few
things it enforces that are easy to miss:

- **No made-up values.** A value nobody knows is shown as missing, with the reason. Never add a
  default, a placeholder or a model's number in place of a measurement. `npm run guard:honest` counts
  patterns that may only go down.
- **Figures need evidence.** A number in the docs comes with its dataset, n and interval, and from a
  report in `evals/reports`.
- **Dependencies age first.** Only releases at least 14 days old. Add packages with `npm install`,
  and do not edit `package-lock.json` by hand.
- **Design tokens.** Colours come from `apps/web/src/styles/tokens.css`; do not add new ones in a
  component.
- **Changes that are meant to change a view** need new visual baselines
  (`npm run test:visual:update`, on Linux x64 with Docker).

Use [Conventional Commits](https://www.conventionalcommits.org/) for titles (`fix(web): ...`), keep
each pull request to one change, and add a line to `CHANGELOG.md` when users would notice it.

## Licence

By contributing, you agree that your contribution is licensed under the
[AGPL-3.0-only](LICENSE), as the project is.
