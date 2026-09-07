/**
 * The log file: docs/dokomade/<author>/<YYYY-MM-DD>.md
 *
 * Append-only, one row per prompt. Rows are never rewritten wholesale - only
 * two single cells are: 작업 (`dokomade retitle`) and 상태 (`dokomade
 * commit`/`push`). Grouping small edits into a larger narrative still happens
 * later, when `commit` reads the whole window at once.
 */
import fs from "node:fs";
import path from "node:path";
import type { LineDelta } from "./git.js";

export interface FileChange extends LineDelta {
  path: string;
}

/**
 * Where a row's work sits in the git lifecycle.
 *
 * A row is born `stage`. It only moves forward after the git command itself
 * exited 0, so the column can never claim work that git rejected.
 */
export type RowStatus = "stage" | "commit" | "push";

export interface LogRow {
  at: Date;
  summary: string;
  files: FileChange[];
  durationMs: number;
  author: string;
  status?: RowStatus;
}

const HEADER_COLUMNS = "| 시각 | 작업 | 파일 | 소요 | 작성자 | 상태 |";
const HEADER_RULE = "| ----- | --- | ---- | ---- | ------ | ----- |";

/** How many cells a current row has. Anything shorter predates 상태. */
export const COLUMN_COUNT = 6;
const STATUS_INDEX = 5;

/**
 * The header, however a formatter has since padded it. Matching on the first
 * cell's text rather than the exact string matters: prettier reflows these
 * tables to align the columns, and an exact-string check would then miss the
 * header and upgrade it on every append.
 */
const HEADER_LINE = /^\s*\|\s*시각\s*\|/;
const TIME_CELL = /^\d{2}:\d{2}$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function timeKey(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

/** Pipes and newlines would break the table row they sit in. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function formatFiles(files: FileChange[]): string {
  if (files.length === 0) return "-";
  return files
    .map((f) => `\`${cell(path.posix.basename(f.path))}\` +${f.added}/-${f.removed}`)
    .join("<br>");
}

export function logPath(root: string, logDir: string, author: string, at: Date): string {
  // Author names contain spaces and, on some setups, slashes.
  const safeAuthor = author.replace(/[\\/]/g, "-").trim() || "unknown";
  return path.join(root, logDir, safeAuthor, `${dateKey(at)}.md`);
}

/**
 * Split a table line into its cells.
 *
 * `String.split("|")` cannot do this: `cell()` escapes a pipe inside a summary
 * as `\|`, and splitting naively would tear "a \| b" into two cells and shift
 * every column after it - including 상태.
 */
export function splitCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const cells: string[] = [];
  let cur = "";
  for (let i = 1; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (trimmed[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += trimmed[i];
  }
  // Text after the final pipe means the row is malformed; keep it rather than
  // dropping a cell silently.
  if (cur.trim()) cells.push(cur.trim());
  return cells;
}

export function joinCells(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** A data row, as opposed to the title, the header, or the rule. */
export function isRowLine(line: string): boolean {
  return TIME_CELL.test(splitCells(line)[0] ?? "");
}

/**
 * A row written before the 상태 column existed has no status cell, and is
 * `stage` by definition: nothing has ever moved it forward.
 */
export function statusOf(line: string): RowStatus {
  const raw = splitCells(line)[STATUS_INDEX];
  return raw === "commit" || raw === "push" ? raw : "stage";
}

export function withStatus(line: string, status: RowStatus): string {
  const cells = splitCells(line);
  if (cells.length === 0) return line;
  while (cells.length < COLUMN_COUNT) cells.push("");
  cells[STATUS_INDEX] = status;
  return joinCells(cells);
}

export function formatRow(row: LogRow): string {
  return joinCells([
    timeKey(row.at),
    cell(row.summary),
    formatFiles(row.files),
    formatDuration(row.durationMs),
    cell(row.author),
    row.status ?? "stage",
  ]);
}

/**
 * Widen a pre-상태 header in place.
 *
 * Markdown renderers drop cells past the header's column count, so appending a
 * 6-cell row under a 5-cell header would render the status invisibly. Runs on
 * every append but writes only on the one append that actually needs it.
 */
export function upgradeHeader(file: string): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return;
  }
  const i = lines.findIndex((l) => HEADER_LINE.test(l));
  if (i === -1 || splitCells(lines[i] as string).length >= COLUMN_COUNT) return;
  lines[i] = HEADER_COLUMNS;
  // The rule line directly under it has to match the new column count.
  if (i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] as string)) {
    lines[i + 1] = HEADER_RULE;
  }
  fs.writeFileSync(file, lines.join("\n"));
}

/** Creates the file with its header on first write, then appends one row. */
export function appendRow(file: string, row: LogRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# ${dateKey(row.at)} — ${cell(row.author)}\n\n${HEADER_COLUMNS}\n${HEADER_RULE}\n`,
    );
  } else {
    upgradeHeader(file);
  }
  fs.appendFileSync(file, `${formatRow(row)}\n`);
}

/**
 * Log files for the last `days` days that exist on disk, oldest first.
 *
 * The window is a window, not "today": work that ran past midnight lands in
 * yesterday's file, and a week without a commit leaves `stage` rows spread
 * across every file since. Reading only today's would strand both.
 */
export function recentLogFiles(
  root: string,
  logDir: string,
  author: string,
  days: number,
  now: Date = new Date(),
): string[] {
  const out: string[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    const file = logPath(root, logDir, author, day);
    if (fs.existsSync(file)) out.push(file);
  }
  return out;
}

export interface StatusChange {
  file: string;
  rows: number;
}

/** Move every `from` row in these files to `to`. Returns what it touched. */
export function setStatus(files: string[], from: RowStatus, to: RowStatus): StatusChange[] {
  const changed: StatusChange[] = [];
  for (const file of files) {
    // Before reading: a pre-상태 file has no status cell to write into, and
    // widening the header rewrites the file underneath us if done after.
    upgradeHeader(file);
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    let rows = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!isRowLine(line) || statusOf(line) !== from) continue;
      lines[i] = withStatus(line, to);
      rows++;
    }
    if (rows > 0) {
      fs.writeFileSync(file, lines.join("\n"));
      changed.push({ file, rows });
    }
  }
  return changed;
}

export interface ParsedRow {
  file: string;
  time: string;
  summary: string;
  status: RowStatus;
}

/** Every row in these files with the given status, in file order. */
export function rowsWithStatus(files: string[], status: RowStatus): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!isRowLine(line) || statusOf(line) !== status) continue;
      const cells = splitCells(line);
      out.push({
        file,
        time: cells[0] as string,
        summary: (cells[1] ?? "").replace(/\\\|/g, "|"),
        status,
      });
    }
  }
  return out;
}
