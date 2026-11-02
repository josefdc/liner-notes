// Which rows of a golden run are recorded as the showcase replays (fixtures/replays), chosen by
// code from the committed run records (evals/agent/runs/<date>/: the after-verifier record of each
// row, d.json, first run, and its normalised result, results/<isrc>.json) and the committed
// styles (evals/showcase-styles.json, written by fetch-styles.mjs).
//
//   node evals/agent/showcase.mjs [--runs evals/agent/runs/2026-10-31] [--min-links 5] [--json]
//
// A row is eligible when every condition holds:
//   - identity: the run resolved the row's own recording (lib/score.mjs identityCorrect);
//   - audio: a measured audio block whose tempo is measured from the signal;
//   - cover: the Cover Art Archive front image of the one release its MusicBrainz evidence names
//     (apps/api/src/replay/cover.ts, the rule the recorder keeps a cover by);
//   - honest: no measured field copied from model text (the contract's analysisIssues), and no
//     model claim or model link shown as sourced unless the judge's verdict sources it
//     (apps/api/src/agent/verifier/index.ts verdictSources; a link asserts a relation) and the
//     claim cites evidence;
//   - map: at least --min-links code-built sourced links in its song-relations map (5 by default:
//     the fewest of the four showcases this set replaces, Bitter Sweet Symphony's);
//   - page: no claim the page shows is named "Possible …" (a possible sample, cover, remix …): the
//     result as the replay serves it (agent/restatements.ts oneClaimPerFact), named by the web's
//     own modules as the Player names a card's and a claim's relation (provenance/claims.ts
//     resultClaims and withoutHiddenRelations, genealogy/links.ts shownLinks and
//     relationLabelsByClaim, genealogy/relationWords.ts withDocumentedRelations,
//     claimRelationKnown and claimRelationWords). A demo choice, not a rule of the product: the
//     showcase shows no hedged relation, so the notes spec (tests/web/notes-view.spec.ts) can
//     check each relation it states is stated once. It leaves out every row whose page hedges a
//     model's relation as "Possible", even one its record documents (Gangsta's Paradise, whose
//     page would show "Possible sample" next to the sample its MusicBrainz record states; README,
//     "The showcase");
//   - style: a MusicBrainz genre in evals/showcase-styles.json.
// The style is that file's, never model text and never the audio service's style classifier
// (printed beside it for reference only). Two styles are the same when their names are equal
// lower-cased (styleKey).
//
// The choice (chooseShowcase): every eligible row that is already a showcase (CURRENT_SHOWCASES,
// so the specs keep their anchors), then the eligible rows whose style is not yet chosen, the
// most code-built sourced links first (ties by ISRC), until at least MIN_TRACKS tracks and
// MIN_STYLES styles are chosen. When the eligible rows cannot reach both, nothing is chosen and
// the script exits 1. A style is the MusicBrainz genre name as written, compared exactly (styleKey): "house",
// "electro house" and "big beat" are three styles, though each is electronic music.
//
// No network, no model call. Needs the contract package built (lib/app.mjs).

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { STYLES_PATH } from "./fetch-styles.mjs";
import { importApp } from "./lib/app.mjs";
import { readGolden, REPO_ROOT } from "./lib/golden.mjs";
import { identityCorrect } from "./lib/score.mjs";

export const DEFAULT_RUNS = join(REPO_ROOT, "evals/agent/runs/2026-10-31");
export const MIN_TRACKS = 5;
export const MIN_STYLES = 4;
export const MIN_LINKS = 5;

/** The showcases this choice keeps when eligible, by slug, with their golden rows' ISRCs. */
export const CURRENT_SHOWCASES = {
  "bitter-sweet-symphony-the-verve": "GBAAA9700049",
  "hung-up-madonna": "USWB10504319",
  "juicy-the-notorious-big": "USBB40000359",
  "one-more-time-daft-punk": "GBDUW0000053",
};

/** Two styles are one when their names are equal lower-cased. */
export const styleKey = (style) => style.trim().toLowerCase();

/** The committed styles by ISRC (evals/showcase-styles.json). */
export function readStyles(path = STYLES_PATH) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  return new Map(file.rows.map((row) => [row.isrc, row]));
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A showcase slug: a current showcase keeps its own; another row's is its title and first
 * credited artist (before " feat.", "," or "&"), lower-cased, letters and digits only, joined by
 * hyphens ("Gangsta's Paradise", "Coolio feat. L.V." -> "gangstas-paradise-coolio"). With
 * `artistFirst`, the artist comes first, for any row: the slug a row takes when its own would
 * hold the query its run was asked (see slugFor).
 */
export function slugOf(row, { artistFirst = false } = {}) {
  const current = Object.entries(CURRENT_SHOWCASES).find(([, isrc]) => isrc === row.isrc);
  if (current && !artistFirst) return current[0];
  const artist = row.artist.split(/\s+feat\.|,|&/i)[0];
  return (artistFirst ? `${artist} ${row.title}` : `${row.title} ${artist}`)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The slug a row is recorded under: slugOf, unless its words hold the query the run was asked
 * while that query is not the result's own title and artist (recorder.ts `leaks` refuses a
 * record that holds such a query: it is what someone typed), and then the artist-first slug.
 * `normalizeQuery` and `publicTexts` are the recorder's (replay/query.ts, publicTextsOf).
 */
export function slugFor(row, query, publicTexts, normalizeQuery) {
  const typed = normalizeQuery(query);
  const holds = (text) => ` ${normalizeQuery(text)} `.includes(` ${typed} `);
  const slug = slugOf(row);
  if (typed === "" || publicTexts.some(holds) || !holds(slug.replaceAll("-", " "))) return slug;
  return slugOf(row, { artistFirst: true });
}

/** The rows of `runsDir` with each condition's result, and whether each row is eligible. */
export async function selectShowcase({
  runsDir = DEFAULT_RUNS,
  minLinks = MIN_LINKS,
  styles = readStyles(),
} = {}) {
  const [
    { archiveCover },
    verifier,
    { analysisIssues },
    { normalizeQuery },
    { publicTextsOf },
    { oneClaimPerFact },
  ] = await Promise.all([
    importApp("apps/api/src/replay/cover.ts"),
    importApp("apps/api/src/agent/verifier/index.ts"),
    import(join(REPO_ROOT, "packages/contract/dist/index.js")),
    importApp("apps/api/src/replay/query.ts"),
    importApp("apps/api/src/replay/recorder.ts"),
    importApp("apps/api/src/agent/restatements.ts"),
  ]);
  const web = await webRelationWords();
  const golden = new Map(readGolden().rows.map((row) => [row.isrc, row]));
  const runs = JSON.parse(readFileSync(join(runsDir, "d.json"), "utf8")).filter(
    (run) => (run.repeat ?? 0) === 0,
  );
  return runs.map((run) => {
    const row = golden.get(run.isrc);
    const analysis = JSON.parse(readFileSync(join(runsDir, "results", `${run.isrc}.json`), "utf8"));
    const evidence = new Map((analysis.evidence ?? []).map((item) => [item.id, item]));
    const links = analysis.genealogy?.links ?? [];
    const linkClaims = new Set(links.map((link) => link.claimId).filter(Boolean));
    const assertsRelation = (claim) =>
      linkClaims.has(claim.id) ||
      verifier.RELATION_ABOUT.has(claim.about) ||
      claim.evidenceIds.some(
        (id) => evidence.has(id) && verifier.isRelationRecord(evidence.get(id)),
      );
    const claims = new Map((analysis.claims ?? []).map((claim) => [claim.id, claim]));
    const fails = [];

    if (!identityCorrect(row, run)) {
      const got = run.identity ? `${run.identity.mbid ?? run.identity.isrc}` : "none";
      fails.push(`identity: resolved ${got}, not ${row.mbid ?? row.isrc}`);
    }
    const audio = analysis.audio;
    if (!audio) {
      fails.push(`audio: none measured (${analysis.audioUnavailableReason ?? "no block"})`);
    } else if (audio.tempo?.basis !== "signal") {
      fails.push(`audio: tempo withheld (${audio.withheld?.tempo?.code ?? "no tempo"})`);
    }
    const cover = archiveCover(analysis);
    if (!cover.url) fails.push(`cover: ${cover.reason.split(":")[0]}`);
    // The normalised result masks the live run's stamps ("[time]"); a live run has none.
    const liveRun = analysis.run && { ...analysis.run, recordedAt: null, commit: null };
    const measuredIssues = analysisIssues({ ...analysis, coverUrl: null, run: liveRun });
    if (measuredIssues.length) fails.push(`honest: ${measuredIssues.join("; ")}`);
    const shownSourced = [...claims.values()].filter(
      (claim) =>
        claim.origin === "model" &&
        claim.kind === "sourced" &&
        !(
          claim.evidenceIds.length > 0 &&
          verifier.verdictSources(claim.verdict, assertsRelation(claim))
        ),
    );
    if (shownSourced.length) {
      fails.push(
        `honest: ${shownSourced.length} model claims shown as sourced without a sourcing verdict`,
      );
    }
    const modelLinks = links.filter(
      (link) =>
        link.origin !== "code" &&
        link.kind === "sourced" &&
        !verifier.verdictSources(claims.get(link.claimId)?.verdict, true),
    );
    if (modelLinks.length) fails.push(`honest: ${modelLinks.length} model links shown as sourced`);
    const possible = possibleRelations(unmaskedTimes(oneClaimPerFact(analysis).result), web);
    if (possible.length) {
      fails.push(`page: ${possible.length} claims shown with a relation named "Possible"`);
    }
    const codeSourced = links.filter((link) => link.origin === "code" && link.kind === "sourced");
    if (codeSourced.length < minLinks) {
      fails.push(`map: ${codeSourced.length} code-built sourced links, fewer than ${minLinks}`);
    }
    const styleRow = styles.get(run.isrc);
    const style = styleRow?.style ?? null;
    if (!style || !styleRow.url) fails.push("style: no MusicBrainz genre");
    return {
      isrc: run.isrc,
      runId: run.runId,
      slug: slugFor(row, run.query, publicTextsOf(analysis), normalizeQuery),
      title: row.title,
      artist: row.artist,
      stratum: row.stratum,
      codeSourcedLinks: codeSourced.length,
      style,
      styleLevel: styleRow?.level ?? null,
      classifierStyle: audio?.fingerprint?.styles?.top?.[0]?.label ?? null,
      fails,
      eligible: fails.length === 0,
    };
  });
}

/** When a normalised result's sources were read, masked ("[time]"), for the page's reading. */
const READ_AT = "2026-10-31T00:00:00.000Z";

/**
 * A normalised result whose evidence the page can read: the page keeps only evidence with a
 * time it was read, and the normalisation masks that time (RESULT_MASKS). Naming a relation
 * does not read it.
 */
export function unmaskedTimes(result) {
  const evidence = (result.evidence ?? []).map((item) =>
    item.retrievedAt === "[time]" ? { ...item, retrievedAt: READ_AT } : item,
  );
  return { ...result, evidence };
}

/** The web's modules that name a relation on the page (see possibleRelations). */
export async function webRelationWords() {
  const claims = await importApp("apps/web/src/components/provenance/claims.ts");
  const links = await importApp("apps/web/src/components/genealogy/links.ts");
  const words = await importApp("apps/web/src/components/genealogy/relationWords.ts");
  return { ...claims, ...links, ...words };
}

/**
 * The claims the page shows whose relation it names "Possible …", each with those words: the
 * Player's naming (apps/web/src/components/Player.tsx `claimRelations`, InteractiveFactoid.tsx
 * `factoidCategory`, ClaimList.tsx), on the result as served. `web` is webRelationWords().
 */
export function possibleRelations(track, web) {
  const claims = web.resultClaims(track);
  const genealogy = web.withoutHiddenRelations(track.genealogy, claims.isHidden);
  const graphLinks = web.shownLinks(
    genealogy,
    web.linkContext(track.evidence, claims, { releaseYear: track.releaseYear }),
  );
  const named = web.withDocumentedRelations(web.relationLabelsByClaim(graphLinks), claims.all);
  return claims.shown.flatMap((shown) => {
    const known = web.claimRelationKnown(shown.kind, shown.claim);
    const words = web.claimRelationWords(shown.claim.about, known, named.get(shown.claim.id));
    return words?.startsWith("Possible") ? [{ id: shown.claim.id, words }] : [];
  });
}

/**
 * The showcase from the selected rows (see the header): the eligible current showcases, then the
 * richest maps that add a style, until `minTracks` tracks and `minStyles` styles, by slug; null
 * when the eligible rows cannot reach both.
 */
export function chooseShowcase(rows, { minTracks = MIN_TRACKS, minStyles = MIN_STYLES } = {}) {
  const eligible = rows.filter((row) => row.eligible);
  const current = new Set(Object.values(CURRENT_SHOWCASES));
  const chosen = eligible.filter((row) => current.has(row.isrc));
  const styles = new Set(chosen.map((row) => styleKey(row.style)));
  const others = eligible
    .filter((row) => !current.has(row.isrc))
    .sort((a, b) => b.codeSourcedLinks - a.codeSourcedLinks || byString(a.isrc, b.isrc));
  const met = () => chosen.length >= minTracks && styles.size >= minStyles;
  for (const row of others) {
    if (met()) break;
    if (styles.has(styleKey(row.style))) continue;
    chosen.push(row);
    styles.add(styleKey(row.style));
  }
  return met() ? chosen.sort((a, b) => byString(a.slug, b.slug)) : null;
}

/** Code-built sourced links in each recording of `dir` (the threshold's reference). */
export function linkCounts(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const { analysis } = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const n = analysis.genealogy.links.filter(
          (link) => link.origin === "code" && link.kind === "sourced",
        ).length;
        return [name.slice(0, -".json".length), n];
      }),
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: DEFAULT_RUNS },
      "min-links": { type: "string", default: String(MIN_LINKS) },
      json: { type: "boolean", default: false },
    },
  });
  const minLinks = Number(values["min-links"]);
  const rows = await selectShowcase({ runsDir: resolve(values.runs), minLinks });
  const chosen = chooseShowcase(rows);
  if (values.json) {
    console.log(JSON.stringify({ rows, chosen }, null, 2));
  } else {
    const previous = linkCounts(join(REPO_ROOT, "fixtures/pinned/9971adea845d"));
    console.log(`code-built sourced links of the showcases before: ${JSON.stringify(previous)}`);
    console.log(`threshold: at least ${minLinks} code-built sourced links\n`);
    console.log(
      "| isrc | track | stratum | code links | style (MusicBrainz) | classifier top style (not used) | result |",
    );
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows) {
      const style = r.style ? `${r.style} (${r.styleLevel})` : "none";
      const result = r.eligible
        ? chosen?.includes(r)
          ? `chosen: ${r.slug}`
          : "eligible"
        : r.fails.join("; ");
      console.log(
        `| ${r.isrc} | ${r.title} — ${r.artist} | ${r.stratum} | ${r.codeSourcedLinks} | ${style} | ${r.classifierStyle ?? "-"} | ${result} |`,
      );
    }
    const eligible = rows.filter((r) => r.eligible);
    console.log(
      `\neligible: ${eligible.length}; styles among them: ${new Set(eligible.map((r) => styleKey(r.style))).size}`,
    );
    if (chosen) {
      console.log(
        `chosen (${chosen.length} tracks, ${new Set(chosen.map((r) => styleKey(r.style))).size} styles):`,
      );
      for (const r of chosen) console.log(`  ${r.slug}  run ${r.runId}  ${r.style}`);
    } else {
      console.log(`no choice reaches ${MIN_TRACKS} tracks and ${MIN_STYLES} styles`);
    }
  }
  if (!chosen) process.exitCode = 1;
}
