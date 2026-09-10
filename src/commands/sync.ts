/** `dokomade sync` - send rows added by the last push to Notion and Sheets. */
import { execFileSync } from "node:child_process"
import { loadEnvFile, notionEnv, sheetsEnv } from "../core/env.js"
import { isRepo, resolveRev } from "../core/git.js"
import { parseSyncRow, type SyncRow } from "../core/markdown.js"
import { findRoot, paths, readConfig, safeRelativePath } from "../core/store.js"
import { syncNotion } from "../integrations/notion.js"
import { syncSheets } from "../integrations/sheets.js"
import type { SyncResult } from "../integrations/types.js"

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

export interface SyncOptions {
  since?: string
  /** List the rows that would be sent and send nothing. */
  dryRun?: boolean
}

export function addedRows(diff: string): SyncRow[] {
  const rows: SyncRow[] = []
  let file = ""
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim()
      file = target === "/dev/null" ? "" : target.replace(/^b\//, "")
      continue
    }
    if (!file || !line.startsWith("+") || line.startsWith("+++")) continue
    const row = parseSyncRow(line.slice(1), file)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * The revision the diff starts from.
 *
 * A caller's `since` is trusted only once git can resolve it. CI passes
 * `github.event.before`, which is forty zeros on a branch's first push and
 * empty on workflow_dispatch - both unresolvable, and both would otherwise
 * fall through to the empty tree and re-send the entire log as duplicate
 * pages. HEAD~1 is the honest answer there: the push that created the branch
 * still only added the rows in its own commits.
 */
function sinceRev(root: string, since: string): string {
  return resolveRev(root, since) ?? "HEAD~1"
}

function logDiff(root: string, since: string, logDir: string): string {
  const run = (from: string): string =>
    execFileSync("git", ["-C", root, "diff", "--no-color", "--unified=0", from, "HEAD", "--", logDir], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
  try {
    return run(sinceRev(root, since))
  } catch {
    // Only a repo whose HEAD is its first commit reaches this: there is no
    // HEAD~1, and every row in the log is genuinely new.
    return run(EMPTY_TREE)
  }
}

function report(result: SyncResult): void {
  const status = result.failed === 0 ? "ok" : "FAILED"
  console.log(`${result.service.padEnd(7)} ${result.sent} sent, ${result.failed} failed  ${status}`)
  for (const error of result.errors) console.error(`        ${error}`)
}

export async function sync(options: SyncOptions = {}, cwd: string = process.cwd()): Promise<void> {
  const root = findRoot(cwd)
  if (!root) {
    console.error("sync: dokomade is not initialised here")
    process.exitCode = 1
    return
  }

  loadEnvFile(root)
  if (!isRepo(root)) {
    console.error("sync: a Git repository is required to identify new log rows; run git init first")
    process.exitCode = 1
    return
  }
  const config = readConfig(paths(root))
  const logDir = safeRelativePath(config.logDir, "docs/dokomade")
  const rows = addedRows(logDiff(root, options.since ?? "HEAD~1", logDir))
  if (rows.length === 0) {
    console.log("sync: no new log rows")
    return
  }

  if (options.dryRun) {
    console.log(`sync: ${rows.length} new row(s)`)
    for (const row of rows) {
      console.log(`  ${row.date} ${row.time}  ${row.summary}  (${row.files.length} files)`)
    }
    return
  }

  const notion = config.integrations.notion ? notionEnv() : null
  const sheets = config.integrations.sheets ? sheetsEnv() : null
  if (config.integrations.notion && !notion) {
    console.error("sync: notion is enabled but DOKOMADE_NOTION_TOKEN/DOKOMADE_NOTION_DB are unset")
    process.exitCode = 1
  }
  if (config.integrations.sheets && !sheets) {
    console.error("sync: sheets is enabled but DOKOMADE_SHEETS_KEY/DOKOMADE_SHEETS_ID are unset")
    process.exitCode = 1
  }
  if (!notion && !sheets) return

  console.log(`sync: ${rows.length} new row(s)`)
  const results = await Promise.allSettled([
    notion ? syncNotion(rows, notion) : Promise.resolve(null),
    sheets ? syncSheets(rows, sheets) : Promise.resolve(null),
  ])
  for (const outcome of results) {
    if (outcome.status === "rejected") {
      console.error(`sync: ${String(outcome.reason)}`)
      process.exitCode = 1
      continue
    }
    if (!outcome.value) continue
    report(outcome.value)
    if (outcome.value.failed > 0) process.exitCode = 1
  }
}
