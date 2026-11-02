# Release checklist

How to cut v0.1.0 and each release after it. A release is a git tag (`vX.Y.Z`) on a commit of
`main`, with its notes on GitHub. The package manifests are private (`"private": true`) and are
never published, so their `version` fields are not the release number and are left as they are.

Publishing a release, and changing the repository's visibility, are the owner's decisions. The
steps below prepare a draft; they never publish it.

## 1. Local CI on the release commit

Run the jobs of `.github/workflows/ci.yml` on a clean checkout of the commit to be released,
with Node 24 and npm 11.18 or later, locally when GitHub Actions cannot run them:

```bash
npm ci
npm run lint
npm run check:links
npm run guard:honest -- --base <previous release tag>
npm run contract:check -- --base <previous release tag>
npm run check:release-age -- --base <previous release tag>
npm run typecheck
npm test
node --test 'evals/**/*.test.mjs'
npm run test:replay
npm run build && npm run check:css
npm run test:e2e
npm run test:visual            # Linux x64 with Docker
cd services/audio && uv sync --frozen && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```

For the first release there is no previous tag: use `--base <release commit>^`, the release
commit's parent. Also run the agent eval replay with the network denied, as CI does (the "Agent eval
replay" and "Agent eval report and judge replay" steps of the `node` job), and
`docker compose -f deploy/compose.prod.yml build` followed by `deploy/check-stack.sh` (README,
"Deploying"), as `.github/workflows/docker.yml` does.

Every step must pass. Keep the output: the release notes quote the test counts.

## 2. Acceptance on main

On the release commit, checked out from `main`:

- the showcase replays open in the app (`npm run dev` with `REPLAY_MODE=only` in
  `apps/api/.env`, then each of `fixtures/replays/*.json` by its query);
- `node evals/agent/showcase.mjs` chooses exactly the committed showcase
  (`node --test evals/agent/showcase.test.mjs`);
- `node evals/agent/kinds.mjs --check` passes: `evals/reports/agent-kinds.md` and
  `docs/images/agent-kinds.svg` are what the committed run records give. It does not read the
  README;
- `npm run check:links` passes: every relative link and anchor in the tracked Markdown files
  points at a tracked file or heading. It checks no figure and no external link;
- checked by hand, since no script reads the README's prose: every number in its "What the
  results hold, by kind" and "Evaluation" sections is the one in the report it cites;
- `git status` is clean.

## 3. CHANGELOG

In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a new empty
`## [Unreleased]` above it, and update the link references at the bottom (`[X.Y.Z]` to the
tag's page, `[Unreleased]` to `compare/vX.Y.Z...main`). Each entry names its pull requests.
Commit it on a branch, as `docs: changelog for vX.Y.Z`, and merge it; the tag goes on that
merge's commit on `main`.

## 4. Tag and draft

```bash
git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --draft --verify-tag --title "vX.Y.Z" --notes-file <notes.md>
```

The notes are the version's CHANGELOG section, then the local CI results of step 1 (each job
and its counts), and the known limitations of the README by link. Images are built from the tag
(`IMAGE_TAG=<short hash>`, `deploy/RUNBOOK.md`, "Deploy a new release"); they are not attached
to the release.

## 5. The owner publishes

The owner reads the draft and publishes it. The repository's visibility is the owner's to
change. Until the repository is public, the source offer in `NOTICE` does not hold, and the site
stays private (`deploy/RUNBOOK.md`, "Two guards").
