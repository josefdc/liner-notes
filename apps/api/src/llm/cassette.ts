/**
 * LLM cassettes: recorded model answers, so tests and evals replay a call without the network.
 *
 *   LLM_CASSETTE=record   live calls (budget guard included); each answer is written to a cassette
 *   LLM_CASSETTE=replay   no network and no spending: a call without a cassette fails (cassette_miss)
 *   LLM_CASSETTE=off      live calls, nothing recorded (default outside tests)
 *   LLM_CASSETTE_DIR      where cassettes live (default: apps/api/cassettes/llm)
 *
 * The api test setup defaults to replay (test/setup/llmReplay.ts). Either mode is refused when
 * NODE_ENV=production (config/settings.ts).
 *
 * A cassette's key is a hash of the tier and its deployment, the reasoning effort, the call's
 * max output tokens, the schema name and a hash of the exact JSON Schema sent, and the messages
 * normalised: roles and text only (message ids and other metadata dropped), line endings and
 * outer whitespace unified, ISO date-times and the run id replaced by placeholders. So a call
 * that differs only in when or in which run it was made replays the same answer, while any
 * change to a prompt, tier, deployment, effort, output budget or schema (a description or a
 * nullable field included) is a miss. A date-time written into a prompt also becomes a
 * placeholder: two prompts that differ only in one replay the same answer.
 *
 * A recorded cassette holds the normalised messages, the parsed answer and the token usage,
 * with every known credential value and token-shaped secret removed; request headers are never
 * recorded, and a cassette that would still contain the API key is not written.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { API_ROOT } from "../config/apiPackage.js";
import type { LlmTier } from "../config/settings.js";
import { LlmError } from "./errors.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Token counts as the provider reported them; null when it did not. */
export interface CassetteUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface CassetteEntry {
  version: 1;
  key: string;
  tier: LlmTier;
  deployment: string;
  schemaName: string;
  messages: LlmMessage[];
  output: unknown;
  usage: CassetteUsage;
}

export interface CassetteKeyInput {
  tier: LlmTier;
  deployment: string;
  schemaName: string;
  /** The JSON Schema exactly as sent. */
  jsonSchema: unknown;
  reasoningEffort: string;
  maxOutputTokens: number;
  messages: readonly LlmMessage[];
  /** Values that change from run to run (the run id, a thread id), replaced by a placeholder. */
  volatile?: readonly string[];
}

/** LLM_CASSETTE_DIR, a relative path resolved against apps/api; the default when unset. */
export function cassetteDirFor(configured: string | null): string {
  return configured ? resolve(API_ROOT, configured) : join(API_ROOT, "cassettes", "llm");
}

const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** The messages as they enter the key: role and text only, volatile values replaced. */
export function normaliseMessages(
  messages: readonly LlmMessage[],
  volatile: readonly string[] = [],
): LlmMessage[] {
  // Longest first, so a value containing a shorter one is replaced whole. Very short values
  // would match ordinary text, so they are left alone.
  const values = [...new Set(volatile)]
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
  return messages.map(({ role, content }) => {
    let text = content.replace(/\r\n?/g, "\n").trim();
    for (const value of values) text = text.split(value).join("<id>");
    text = text.replace(ISO_TIMESTAMP, "<timestamp>");
    return { role, content: text };
  });
}

export function cassetteKey(input: CassetteKeyInput): string {
  const material = JSON.stringify({
    tier: input.tier,
    deployment: input.deployment,
    effort: input.reasoningEffort,
    maxOutputTokens: input.maxOutputTokens,
    schema: input.schemaName,
    schemaHash: createHash("sha256").update(JSON.stringify(input.jsonSchema)).digest("hex"),
    messages: normaliseMessages(input.messages, input.volatile),
  });
  return createHash("sha256").update(material).digest("hex");
}

function cassettePath(dir: string, entry: Pick<CassetteEntry, "schemaName" | "tier" | "key">) {
  const schema = entry.schemaName.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(dir, `${schema}.${entry.tier}.${entry.key.slice(0, 24)}.json`);
}

// =============================================================================
// Secret scrubbing
// =============================================================================

/** Variables whose values are credentials whatever their length. */
const CREDENTIAL_VARIABLES = ["AZURE_OPENAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"];

/**
 * Credential values in the environment, trimmed (as the settings use them), plus `extra`
 * (the settings' key, the endpoint's host), longest first.
 */
export function knownSecrets(
  env: NodeJS.ProcessEnv = process.env,
  extra: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const fromEnv = Object.entries(env)
    .map(([name, value]) => [name, value?.trim() ?? ""] as const)
    .filter(([name, value]) =>
      CREDENTIAL_VARIABLES.includes(name)
        ? value.length >= 4
        : /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && value.length >= 8,
    )
    .map(([, value]) => value);
  const all = [...fromEnv, ...extra.filter((v): v is string => Boolean(v && v.length >= 4))];
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
  [/\b(api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
];

function scrubString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A copy of `value` with every string scrubbed of credentials. */
export function scrubSecrets<T>(value: T, secrets: readonly string[] = knownSecrets()): T {
  if (typeof value === "string") return scrubString(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubSecrets(item, secrets)]),
    ) as T;
  }
  return value;
}

// =============================================================================
// Reading and writing
// =============================================================================

export async function readCassette(
  dir: string,
  lookup: Pick<CassetteEntry, "schemaName" | "tier" | "key">,
  callSite: string,
): Promise<CassetteEntry> {
  const path = cassettePath(dir, lookup);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LlmError(
        "cassette_miss",
        `${callSite}: no LLM cassette for ${lookup.schemaName} on tier ${lookup.tier} ` +
          `(key ${lookup.key.slice(0, 24)}) in ${dir}; record it with LLM_CASSETTE=record`,
      );
    }
    throw new LlmError(
      "cassette_io",
      `${callSite}: cannot read LLM cassette ${path} (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  let entry: CassetteEntry;
  try {
    entry = JSON.parse(text) as CassetteEntry;
  } catch {
    throw new LlmError("cassette_io", `${callSite}: LLM cassette ${path} is not valid JSON`);
  }
  if (entry?.version !== 1 || entry.key !== lookup.key || !entry.usage) {
    throw new LlmError(
      "cassette_io",
      `${callSite}: LLM cassette ${path} is not a version 1 entry for this key`,
    );
  }
  return entry;
}

let tmpCounter = 0;

/**
 * Writes an entry atomically (temp file + rename), scrubbed of `secrets` (by default those of
 * the environment). `apiKey` is the key the client sends; a cassette containing it is refused.
 */
export async function writeCassette(
  dir: string,
  entry: CassetteEntry,
  secrets: readonly string[] = knownSecrets(),
  apiKey: string | null = process.env.AZURE_OPENAI_API_KEY?.trim() || null,
): Promise<string> {
  const scrubbed = scrubSecrets(entry, apiKey ? [apiKey, ...secrets] : secrets);
  const text = `${JSON.stringify(scrubbed, null, 2)}\n`;
  if (apiKey && text.includes(apiKey)) {
    throw new LlmError(
      "cassette_io",
      "refusing to write an LLM cassette that contains the API key",
    );
  }
  const path = cassettePath(dir, entry);
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw new LlmError(
      "cassette_io",
      `cannot write LLM cassette ${path} (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  return path;
}
