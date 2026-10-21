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
 * process died: a crash leaves its reservation counted, at the worst case). Any malformed line,
 * the last one included and whether or not it ends with a newline, makes the log unusable:
 * spending that cannot be summed is refused, not guessed, and the layer never cuts a line it did
 * not write. A valid last line without a newline (written by hand) is kept; the next append
 * starts a new line.
 *
 * Writes: one line per write, under the lock. When a write is cut short or cannot be flushed,
 * the file is truncated back to its size before the write (only the layer's own bytes are
 * removed) and the call is refused. A last line torn by a power loss, which no process could
 * undo, is moved aside only by hand: `npm run smoke:llm -w apps/api -- --repair-tail` prints
 * its length and moves that one line to `<log>.torn` (`repairTornTail`).
 *
 * A missing log is refused, not taken as empty, so a mistyped path cannot start a fresh budget
 * at USD 0; `smoke:llm -- --init` creates one explicitly (`createSpendLog`).
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
  /** For a failed append: part of the line may have stayed in the file. */
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
      "(a missing log is never taken as USD 0 spent)",
  );
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    throw new SpendLogError(`LLM_SPEND_LOG cannot be read (${code(error)})`);
  }
}

/** Reads and parses the log; a missing file or any malformed line is an error. */
export async function readSpendLog(path: string): Promise<SpendLogContents> {
  const text = await readText(path);
  let lines: SpendLine[];
  try {
    lines = parseSpendLog(text);
  } catch (error) {
    const last = text.replace(/\n+$/, "").split("\n").length;
    const lineNo = Number((error as Error).message.match(/line (\d+)/)?.[1]);
    const hint =
      lineNo === last
        ? "; if a power loss cut the last line, run `npm run smoke:llm -w apps/api -- --repair-tail`"
        : "; fix or remove it by hand";
    throw new SpendLogError(`${(error as Error).message}${hint}`);
  }
  return { lines, unterminated: text !== "" && !text.endsWith("\n") };
}

export interface TailRepair {
  /** Whether a line was moved. */
  moved: boolean;
  /** Bytes of the moved line. */
  bytes: number;
}

/**
 * Moves the log's last line to `<path>.torn` and cuts it from the log, only when that line is
 * not a valid record (lines before it are left alone, malformed or not). For a line torn by a
 * power loss; run by hand only (smoke:llm --repair-tail). Call under the lock.
 */
export async function repairTornTail(path: string): Promise<TailRepair> {
  const text = await readText(path);
  const body = text.replace(/\n+$/, "");
  if (body === "") return { moved: false, bytes: 0 };
  const cut = body.lastIndexOf("\n") + 1;
  const lastLine = body.slice(cut);
  if (typeof parseLine(lastLine) !== "string") return { moved: false, bytes: 0 };
  const bytes = Buffer.byteLength(text.slice(cut), "utf8");
  await appendFile(
    `${path}.torn`,
    `# ${new Date().toISOString()} last line (${bytes} bytes) moved from the spend log by hand\n${lastLine}\n`,
  );
  await truncate(path, Buffer.byteLength(text.slice(0, cut), "utf8"));
  return { moved: true, bytes };
}

/**
 * Whether the next append must start a new line, reading only the end of the file when it ends
 * with a newline. Call under the lock.
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
  // Refuses a malformed last line; a valid hand-written one needs a newline first.
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

/** The file handle operations appendLine uses; replaceable in tests to simulate disk faults. */
export interface AppendHandle {
  stat(): Promise<{ size: number }>;
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Appends one line with a single write, checked for length and flushed before returning. Call
 * under the lock. When the write is cut short or cannot be flushed, the file is truncated back
 * to its size before the write and SpendLogError is thrown; if even that fails, the error says
 * the log may now end with a partial line (which then refuses every call until repaired).
 */
export async function appendLine(
  path: string,
  line: SpendLine,
  startNewLine = false,
  openHandle: (path: string) => Promise<AppendHandle> = (p) =>
    // Append without O_CREAT: a log removed meanwhile is an error, never recreated empty.
    open(p, constants.O_WRONLY | constants.O_APPEND),
): Promise<void> {
  const data = Buffer.from(`${startNewLine ? "\n" : ""}${JSON.stringify(line)}\n`, "utf8");
  let handle: AppendHandle;
  try {
    handle = await openHandle(path);
  } catch (error) {
    if (code(error) === "ENOENT") throw missing();
    throw new SpendLogError(`LLM_SPEND_LOG cannot be written (${code(error)})`);
  }
  let before: number | null = null;
  try {
    before = (await handle.stat()).size;
    const { bytesWritten } = await handle.write(data, 0, data.length);
    if (bytesWritten !== data.length) {
      throw new SpendLogError(
        `LLM_SPEND_LOG write was cut short (${bytesWritten} of ${data.length} bytes)`,
      );
    }
    await handle.sync();
  } catch (error) {
    const reason =
      error instanceof SpendLogError
        ? error.message
        : `LLM_SPEND_LOG cannot be written (${code(error)})`;
    if (before === null) throw new SpendLogError(reason);
    const undone = await handle.truncate(before).then(
      () => true,
      () => false,
    );
    throw new SpendLogError(
      undone
        ? `${reason}; the partial line was removed`
        : `${reason}; it could not be removed, so the log may end with a partial line`,
      !undone,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
