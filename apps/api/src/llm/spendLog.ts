/**
 * The spend log: the authoritative, cross-process record of model spending (LLM_SPEND_LOG).
 *
 * One JSON object per line, appended under a file lock (fileLock.ts). Every app process, test
 * database, worktree and eval harness pointed at the same file counts against the same caps;
 * the `llm_usage` table of an app database is only a per-database copy for reports.
 *
 * Lines (fields in this order; `ts`, `deployment`, `in`, `out`, `usd_est` and `unit` are the
 * base format, on every line, and all a hand-written line needs):
 *
 *   {"ts","deployment","in","out","usd_est","unit","v":1,"kind":"reserve","id","tier",
 *    "callSite","runId","multiplier","pid"}
 *     written before a call: `in` is the input bound, `out` the call's max_output_tokens,
 *     `usd_est` their worst-case cost at table prices × multiplier.
 *   {..., "kind":"settle","id","reserve_ts", ..., "reasoning","latency_ms","status","estimated"}
 *     written after the call, same `id`: `in`/`out` as reported by the provider (`out` includes
 *     `reasoning`), `usd_est` their cost. `estimated: true` when the outcome is unknown (no
 *     usage reported, a timeout, a dropped connection) and the reservation's worst case is kept.
 *     `reserve_ts` is the reservation's time: the call counts on that day (UTC).
 *
 * `unit` is the purpose (dev, eval, showcase, eval:golden, …). A line without `kind` (written
 * by hand or by another tool) counts as settled spending.
 *
 * Totals: settled lines, plus reservations with no settle line (a call in flight, or one whose
 * process died: a crash leaves its reservation counted, at the worst case). A malformed line
 * inside the log makes it unusable: spending that cannot be summed is refused, not guessed.
 * A torn last line (no newline, not a valid record: a write cut short) is moved to
 * `<log>.torn` and cut from the log, with a warning. That never under-counts: a reservation
 * whose write was cut short was refused (or its process died before calling), and a cut settle
 * leaves its reservation counted at the worst case.
 *
 * A missing log is refused, not taken as empty, so a mistyped path cannot start a fresh budget
 * at USD 0; `createSpendLog` makes one explicitly (LLM_SPEND_LOG_INIT=1, smoke:llm --init).
 *
 * Every reservation reads and parses the whole log once (about 300 bytes per line, two lines
 * per call); a settle reads only its tail. At thousands of calls this stays in milliseconds.
 */

import { constants } from "node:fs";
import { access, appendFile, open, readFile, stat, truncate } from "node:fs/promises";

export interface SpendLine {
  ts: string;
  deployment: string;
  in: number;
  out: number;
  usd_est: number;
  unit: string;
  v?: 1;
  kind?: "reserve" | "settle";
  id?: string;
  reserve_ts?: string;
  tier?: string;
  callSite?: string;
  runId?: string;
  multiplier?: number;
  reasoning?: number | null;
  latency_ms?: number;
  status?: string;
  estimated?: boolean;
  pid?: number;
}

export class SpendLogError extends Error {
  override readonly name = "SpendLogError";
  /** For a failed append: some bytes may have reached the file. */
  constructor(
    message: string,
    readonly written = false,
  ) {
    super(message);
  }
}

export interface SpendTotals {
  /** Settled spending plus open reservations, in USD. */
  totalUsd: number;
  /** The same, for calls reserved today (UTC). */
  todayUsd: number;
  /** The same, per `unit` (purpose). */
  byUnitUsd: Record<string, number>;
  /** Reservations with no settle line. */
  openReservations: number;
  lines: number;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "error";

function invalid(lineNo: number, why: string): SpendLogError {
  return new SpendLogError(`LLM_SPEND_LOG line ${lineNo} is not a valid spend record (${why})`);
}

/** The record on one line, or the reason it is not one. */
function parseLine(row: string): SpendLine | string {
  let value: unknown;
  try {
    value = JSON.parse(row);
  } catch {
    return "not JSON";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  const line = value as Partial<SpendLine>;
  if (typeof line.usd_est !== "number" || !Number.isFinite(line.usd_est) || line.usd_est < 0) {
    return "usd_est is not an amount";
  }
  if (typeof line.ts !== "string" || Number.isNaN(Date.parse(line.ts))) return "ts is not a date";
  if (line.kind !== undefined && line.kind !== "reserve" && line.kind !== "settle") {
    return "unknown kind";
  }
  if (line.kind !== undefined && typeof line.id !== "string") {
    return "a reserve or settle line needs an id";
  }
  return line as SpendLine;
}

/** Parses the log's text; throws SpendLogError naming the first malformed line. */
export function parseSpendLog(text: string): SpendLine[] {
  const lines: SpendLine[] = [];
  text.split("\n").forEach((row, index) => {
    if (row.trim() === "") return;
    const line = parseLine(row);
    if (typeof line === "string") throw invalid(index + 1, line);
    lines.push(line);
  });
  return lines;
}

const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Sums the log: a settle line replaces its reservation; open reservations count in full. */
export function summarise(lines: readonly SpendLine[], now: Date = new Date()): SpendTotals {
  const settled = new Set(lines.filter((l) => l.kind === "settle").map((l) => l.id));
  const totals: SpendTotals = {
    totalUsd: 0,
    todayUsd: 0,
    byUnitUsd: {},
    openReservations: 0,
    lines: lines.length,
  };
  const today = now.toISOString().slice(0, 10);
  for (const line of lines) {
    if (line.kind === "reserve") {
      if (settled.has(line.id)) continue;
      totals.openReservations += 1;
    }
    totals.totalUsd += line.usd_est;
    // A call counts on the day it was reserved, so a settle after midnight cannot move it.
    const day = line.kind === "settle" && line.reserve_ts ? line.reserve_ts : line.ts;
    if (!Number.isNaN(Date.parse(day)) && utcDay(day) === today) totals.todayUsd += line.usd_est;
    const unit = typeof line.unit === "string" ? line.unit : "";
    totals.byUnitUsd[unit] = (totals.byUnitUsd[unit] ?? 0) + line.usd_est;
  }
  return totals;
}

export interface SpendLogContents {
  lines: SpendLine[];
  /** The file does not end with a newline (a hand-written last line): appends start one. */
  unterminated: boolean;
}

function missing(): SpendLogError {
  return new SpendLogError(
    "LLM_SPEND_LOG does not exist; create it once with `npm run smoke:llm -w apps/api -- --init` " +
      "or LLM_SPEND_LOG_INIT=1 (a missing log is never taken as USD 0 spent)",
  );
}

/** Moves a torn last line to `<path>.torn` and cuts it from the log. Call under the lock. */
async function quarantineTail(path: string, text: string, cut: number): Promise<void> {
  const fragment = text.slice(cut);
  await appendFile(
    `${path}.torn`,
    `# ${new Date().toISOString()} torn last line cut from the spend log\n${fragment}\n`,
  );
  await truncate(path, Buffer.byteLength(text.slice(0, cut), "utf8"));
  console.warn(
    `[llm] LLM_SPEND_LOG ended with a torn line (a write cut short); moved it to ${path}.torn`,
  );
}

/**
 * Reads and parses the log; a missing file is an error. Call under the lock: a torn last line
 * is quarantined (see the module comment).
 */
export async function readSpendLog(path: string): Promise<SpendLogContents> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    throw new SpendLogError(`LLM_SPEND_LOG cannot be read (${code(error)})`);
  }
  if (text === "" || text.endsWith("\n"))
    return { lines: parseSpendLog(text), unterminated: false };
  const cut = text.lastIndexOf("\n") + 1;
  if (typeof parseLine(text.slice(cut)) !== "string") {
    return { lines: parseSpendLog(text), unterminated: true };
  }
  try {
    await quarantineTail(path, text, cut);
  } catch (error) {
    throw new SpendLogError(
      `LLM_SPEND_LOG has a torn last line that cannot be moved (${code(error)})`,
    );
  }
  return { lines: parseSpendLog(text.slice(0, cut)), unterminated: false };
}

/**
 * Whether the next append must start a new line, reading only the end of the file. A torn
 * tail is quarantined (through readSpendLog). Call under the lock.
 */
export async function needsNewLine(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    throw new SpendLogError(`LLM_SPEND_LOG cannot be read (${code(error)})`);
  }
  if (size === 0) return false;
  const handle = await open(path, "r");
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last.toString() === "\n") return false;
  } finally {
    await handle.close();
  }
  return (await readSpendLog(path)).unterminated;
}

/** Checks the log exists and can be read and written, without changing it. */
export async function checkAccess(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    const mode = await access(path, constants.R_OK).then(
      () => "written",
      () => "read",
    );
    throw new SpendLogError(`LLM_SPEND_LOG cannot be ${mode} (${code(error)})`);
  }
}

/** Creates an empty log if there is none; returns true when it created one. */
export async function createSpendLog(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    await handle.close();
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw new SpendLogError(`LLM_SPEND_LOG cannot be created (${code(error)})`);
  }
}

/**
 * Appends one line with a single write, checked for length and flushed before returning. Call
 * under the lock. On failure, `written` says whether any of the line may be in the file.
 */
export async function appendLine(
  path: string,
  line: SpendLine,
  startNewLine = false,
): Promise<void> {
  const data = Buffer.from(`${startNewLine ? "\n" : ""}${JSON.stringify(line)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Append without O_CREAT: a log removed meanwhile is an error, never recreated empty.
    handle = await open(path, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    throw new SpendLogError(`LLM_SPEND_LOG cannot be written (${code(error)})`);
  }
  let written = false;
  try {
    const { bytesWritten } = await handle.write(data, 0, data.length);
    written = bytesWritten > 0;
    if (bytesWritten !== data.length) {
      throw new SpendLogError(
        `LLM_SPEND_LOG write was cut short (${bytesWritten} of ${data.length} bytes)`,
        written,
      );
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof SpendLogError) throw error;
    throw new SpendLogError(`LLM_SPEND_LOG cannot be written (${code(error)})`, written);
  } finally {
    await handle.close().catch(() => {});
  }
}
