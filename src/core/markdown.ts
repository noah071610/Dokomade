/**
 * The log file: docs/dokomade/<author>/<YYYY-MM-DD>.md
 *
 * Append-only, one row per prompt. Rows are never rewritten wholesale - only
 * the Status cell is updated by `commit`/`push`. Grouping small edits into a larger narrative still happens
 * later, when `commit` reads the whole window at once.
 */
import fs from "node:fs"
import path from "node:path"
import { normalizeScope, type WorkScope } from "./classify.js"
import type { LineDelta } from "./git.js"
import { safeRelativePath, type AiCliId } from "./store.js"

export interface FileChange extends LineDelta {
  path: string
}

/**
 * Where a row's work sits in the git lifecycle.
 *
 * A row is born `stage`. It only moves forward after the git command itself
 * exited 0, so the column can never claim work that git rejected.
 */
export type RowStatus = "stage" | "commit" | "push"

/**
 * Which coding agent produced the row: the adapter that recognised the hook
 * payload, or - for a row `commit` files itself - the CLI that wrote it.
 * `-` when neither is known.
 */
export type AgentName = Exclude<AiCliId, "none">

export interface LogRow {
  at: Date
  summary: string
  goal?: string
  files: FileChange[]
  durationMs: number
  author: string
  scope?: WorkScope
  agent?: AgentName
  status?: RowStatus
}

const HEADER_COLUMNS = "| Time | Task | Goal | Files | Duration | AI | Scope | Status | Author | Date |"
const HEADER_RULE = "| ---- | ---- | ---- | ----- | -------- | -- | ----- | ------ | ------ | ---- |"

/** How many cells a current row has. Older rows are widened on the next write. */
export const COLUMN_COUNT = 10
const GOAL_INDEX = 2
const FILES_INDEX = 3
const DURATION_INDEX = 4
const AGENT_INDEX = 5
const SCOPE_INDEX = 6
const STATUS_INDEX = 7
const AUTHOR_INDEX = 8

const RULE_LINE = /^\s*\|[\s:|-]+\|\s*$/
const TIME_CELL = /^\d{2}:\d{2}$/

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function timeKey(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function dateTimeKey(d: Date): string {
  return `${dateKey(d)}T${timeKey(d)}:00`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${min % 60}m`
}

/** Pipes and newlines would break the table row they sit in. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

/**
 * A value that has to survive as one line inside a cell.
 *
 * Any tag becomes a space rather than nothing, so removing one does not weld
 * the words on either side together.
 */
function oneLine(text: string): string {
  return cell(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "))
}

/** The machine-readable shape of one row sent to an integration. */
export interface SyncRow {
  date: string
  time: string
  summary: string
  goal?: string
  files: FileChange[]
  duration: string
  agent: string
  author: string
  scope?: WorkScope
  status: RowStatus
}

export function formatFiles(files: FileChange[]): string {
  if (files.length === 0) return "-"
  return files.map((f) => `\`${cell(path.posix.basename(f.path))}\` +${f.added}/-${f.removed}`).join("<br>")
}

/** Parse the file cell written by `formatFiles`. */
export function parseFiles(value: string): FileChange[] {
  if (value.trim() === "-") return []
  const out: FileChange[] = []
  const re = /`([^`]*)`\s+\+(\d+)\/-(\d+)/g
  for (const match of value.matchAll(re)) {
    out.push({ path: (match[1] ?? "").replace(/\\\|/g, "|"), added: Number(match[2]), removed: Number(match[3]) })
  }
  return out
}

/**
 * Split the Task cell while keeping compatibility with rows without `goal`.
 *
 * Rows written before `oneLine` can carry more than one `<br>`; everything
 * after the first is rejoined into the motive rather than dropped, so an old
 * row loses neither its text nor its single-line shape.
 */
export function splitTask(value: string): { summary: string; goal?: string } {
  const [summary = "", ...rest] = value.replace(/\\\|/g, "|").split("<br>")
  const goal = rest.join(" ").trim()
  return goal ? { summary: summary.trim(), goal } : { summary: summary.trim() }
}

export function logPath(root: string, logDir: string, author: string, at: Date): string {
  // Author names contain spaces and, on some setups, slashes.
  const safeAuthor = (author.replace(/[\\/]/g, "-").trim() || "unknown")
    .toLowerCase()
    .replace(/\s+/g, "_")
  return path.join(root, safeRelativePath(logDir, "docs/dokomade"), safeAuthor, `${dateKey(at)}.md`)
}

function legacyLogPath(root: string, logDir: string, author: string, at: Date): string {
  const safeAuthor = author.replace(/[\\/]/g, "-").trim() || "unknown"
  return path.join(root, safeRelativePath(logDir, "docs/dokomade"), safeAuthor, `${dateKey(at)}.md`)
}

/**
 * Split a table line into its cells.
 *
 * `String.split("|")` cannot do this: `cell()` escapes a pipe inside a summary
 * as `\|`, and splitting naively would tear "a \| b" into two cells and shift
 * every column after it - including Status.
 */
export function splitCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return []
  const cells: string[] = []
  let cur = ""
  for (let i = 1; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cur += "\\|"
      i++
      continue
    }
    if (trimmed[i] === "|") {
      cells.push(cur.trim())
      cur = ""
      continue
    }
    cur += trimmed[i]
  }
  // Text after the final pipe means the row is malformed; keep it rather than
  // dropping a cell silently.
  if (cur.trim()) cells.push(cur.trim())
  return cells
}

export function joinCells(cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}

/** A data row, as opposed to the title, the header, or the rule. */
export function isRowLine(line: string): boolean {
  return TIME_CELL.test(splitCells(line)[0] ?? "")
}

/**
 * Bring a row's cells up to the current column count and current order.
 *
 * The previous schema combined Task and Goal and placed Author before Scope.
 * Split that row once so existing logs keep both values in the new columns.
 */
function migrateCells(cells: string[], filler: string): string[] {
  if (cells.length === 0 || cells.length >= COLUMN_COUNT) return cells
  const task = splitTask(cells[1] ?? "")

  if (cells.length >= 9) {
    return [
      cells[0] ?? filler,
      task.summary,
      task.goal ?? filler,
      cells[2] ?? filler,
      cells[3] ?? filler,
      cells[4] ?? filler,
      cells[6] ?? filler,
      cells[7] ?? filler,
      cells[5] ?? filler,
      cells[8] ?? filler,
    ]
  }

  if (cells.length >= 7) {
    return [
      cells[0] ?? filler,
      task.summary,
      task.goal ?? filler,
      cells[2] ?? filler,
      cells[3] ?? filler,
      cells[4] ?? filler,
      filler,
      cells[6] ?? filler,
      cells[5] ?? filler,
      filler,
    ]
  }

  return [
    cells[0] ?? filler,
    task.summary,
    task.goal ?? filler,
    cells[2] ?? filler,
    cells[3] ?? filler,
    filler,
    filler,
    cells[5] ?? filler,
    cells[4] ?? filler,
    filler,
  ]
}

/**
 * A row written before the Status column existed has no status cell, and is
 * `stage` by definition: nothing has ever moved it forward.
 */
export function statusOf(line: string): RowStatus {
  const raw = migrateCells(splitCells(line), "")[STATUS_INDEX]
  return raw === "commit" || raw === "push" ? raw : "stage"
}

export function withStatus(line: string, status: RowStatus): string {
  const cells = migrateCells(splitCells(line), "")
  if (cells.length === 0) return line
  cells[STATUS_INDEX] = status
  return joinCells(cells)
}

export function formatRow(row: LogRow): string {
  return joinCells([
    timeKey(row.at),
    oneLine(row.summary),
    row.goal ? oneLine(row.goal) : "",
    formatFiles(row.files),
    formatDuration(row.durationMs),
    row.agent ?? "-",
    cell(row.scope ?? "Etc"),
    row.status ?? "stage",
    cell(row.author),
    dateTimeKey(row.at),
  ])
}

function dateFromLogPath(file: string): string | null {
  const match = file.replaceAll("\\", "/").match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/)
  return match?.[1] ?? null
}

/** Parse one added Markdown row for integration sync. */
export function parseSyncRow(line: string, file: string): SyncRow | null {
  const date = dateFromLogPath(file)
  const cells = splitCells(line)
  if (!date || !isRowLine(line) || RULE_LINE.test(line)) return null
  const migrated = migrateCells(cells, "")
  if (migrated.length < COLUMN_COUNT) return null
  const summary = (migrated[1] ?? "").replace(/\\\|/g, "|")
  const goal = (migrated[GOAL_INDEX] ?? "").replace(/\\\|/g, "|")
  return {
    date,
    time: migrated[0] ?? "",
    summary,
    goal: goal || undefined,
    files: parseFiles(migrated[FILES_INDEX] ?? "-"),
    duration: migrated[DURATION_INDEX] ?? "-",
    agent: migrated[AGENT_INDEX] ?? "-",
    author: (migrated[AUTHOR_INDEX] ?? "").replace(/\\\|/g, "|"),
    scope: normalizeScope(migrated[SCOPE_INDEX] ?? ""),
    status: statusOf(line),
  }
}

export function totalDelta(files: readonly FileChange[]): LineDelta {
  return files.reduce(
    (total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
    { added: 0, removed: 0 },
  )
}

/**
 * Bring a file up to the current schema in place: header, rule, and every row.
 *
 * Markdown renderers drop cells past the header's column count, so a legacy
 * row left at the old width would read its Author as the AI. Rows are only ever
 * reordered or widened, never dropped: no cell's text is lost. The header is
 * different - it is labels, not data, so an out-of-date one is simply replaced.
 * Runs on every append, writes only when something moved.
 */
export function upgradeHeader(file: string): void {
  let lines: string[]
  try {
    lines = fs.readFileSync(file, "utf8").split("\n")
  } catch {
    return
  }
  // The header is the first table line that is neither a rule nor a data row -
  // matching on its text would miss a header whose columns were renamed.
  const i = lines.findIndex((l) => l.trim().startsWith("|") && !RULE_LINE.test(l) && !isRowLine(l))
  let dirty = false
  if (i !== -1 && lines[i] !== HEADER_COLUMNS) {
    lines[i] = HEADER_COLUMNS
    // The rule line directly under it has to match the new column count.
    if (RULE_LINE.test(lines[i + 1] ?? "")) {
      lines[i + 1] = HEADER_RULE
    }
    dirty = true
  }
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string
    if (!isRowLine(line) || splitCells(line).length >= COLUMN_COUNT) continue
    lines[n] = joinCells(migrateCells(splitCells(line), ""))
    dirty = true
  }
  if (dirty) fs.writeFileSync(file, lines.join("\n"))
}

/** Creates the file with its header on first write, then appends one row. */
export function appendRow(file: string, row: LogRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${dateKey(row.at)} - ${cell(row.author)}\n\n${HEADER_COLUMNS}\n${HEADER_RULE}\n`)
  } else {
    upgradeHeader(file)
  }
  fs.appendFileSync(file, `${formatRow(row)}\n`)
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
  const out: string[] = []
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(now)
    day.setDate(day.getDate() - back)
    const file = logPath(root, logDir, author, day)
    if (fs.existsSync(file)) out.push(file)
    else {
      const legacy = legacyLogPath(root, logDir, author, day)
      if (legacy !== file && fs.existsSync(legacy)) out.push(legacy)
    }
  }
  return out
}

export interface StatusChange {
  file: string
  rows: number
}

/** Move every `from` row in these files to `to`. Returns what it touched. */
export function setStatus(files: string[], from: RowStatus, to: RowStatus): StatusChange[] {
  const changed: StatusChange[] = []
  for (const file of files) {
    // Before reading: a pre-Status file has no status cell to write into, and
    // widening the header rewrites the file underneath us if done after.
    upgradeHeader(file)
    let lines: string[]
    try {
      lines = fs.readFileSync(file, "utf8").split("\n")
    } catch {
      continue
    }
    let rows = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!isRowLine(line) || statusOf(line) !== from) continue
      lines[i] = withStatus(line, to)
      rows++
    }
    if (rows > 0) {
      fs.writeFileSync(file, lines.join("\n"))
      changed.push({ file, rows })
    }
  }
  return changed
}

export interface ParsedRow {
  file: string
  time: string
  summary: string
  status: RowStatus
}

/** Every row in these files with the given status, in file order. */
export function rowsWithStatus(files: string[], status: RowStatus): ParsedRow[] {
  const out: ParsedRow[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of raw.split("\n")) {
      if (!isRowLine(line) || statusOf(line) !== status) continue
      const cells = migrateCells(splitCells(line), "")
      out.push({
        file,
        time: cells[0] as string,
        summary: (cells[1] ?? "").replace(/\\\|/g, "|"),
        status,
      })
    }
  }
  return out
}
