/** `dokomade sync` - send the author's unpushed rows to Notion and Sheets. */
import { loadEnvFile, notionEnv, sheetsEnv } from "../core/env.js"
import { authorName, isRepo } from "../core/git.js"
import { allAuthorLogFiles, allLogFiles, rowsToSync } from "../core/markdown.js"
import { findRoot, paths, readConfig, safeRelativePath } from "../core/store.js"
import { syncNotion } from "../integrations/notion.js"
import { syncSheets } from "../integrations/sheets.js"
import type { SyncResult } from "../integrations/types.js"

export interface SyncOptions {
  /** List the rows that would be sent and send nothing. */
  dryRun?: boolean
  /** GitHub Actions에서 팀 전체의 커밋된 로그를 포함한다. */
  allAuthors?: boolean
}

function report(result: SyncResult): void {
  const status = result.failed === 0 ? "ok" : "FAILED"
  console.log(`${result.service.padEnd(7)} ${result.sent} sent, ${result.failed} failed  ${status}`)
  for (const error of result.errors) console.error(`        ${error}`)
}

export async function sync(options: SyncOptions = {}, cwd: string = process.cwd()): Promise<boolean> {
  const root = findRoot(cwd)
  if (!root) {
    console.error("sync: dokomade is not initialised here")
    process.exitCode = 1
    return false
  }

  loadEnvFile(root)
  if (!isRepo(root)) {
    console.error("sync: a Git repository is required; run git init first")
    process.exitCode = 1
    return false
  }
  const config = readConfig(paths(root))
  const logDir = safeRelativePath(config.logDir, "docs/dokomade")
  const files = options.allAuthors ? allAuthorLogFiles(root, logDir) : allLogFiles(root, logDir, authorName(root))
  const rows = rowsToSync(files)
  if (rows.length === 0) {
    console.log("sync: no unpushed log rows")
    return true
  }

  if (options.dryRun) {
    console.log(`sync: ${rows.length} unpushed row(s)`)
    for (const row of rows) {
      console.log(`  ${row.date} ${row.time}  ${row.summary}  (${row.files.length} files)`)
    }
    return true
  }

  const notion = config.integrations.notion ? notionEnv() : null
  const sheets = config.integrations.sheets ? sheetsEnv() : null
  let ok = true
  if (config.integrations.notion && !notion) {
    console.error("sync: notion is enabled but DOKOMADE_NOTION_TOKEN/DOKOMADE_NOTION_DB are unset")
    ok = false
  }
  if (config.integrations.sheets && !sheets) {
    console.error("sync: sheets is enabled but DOKOMADE_SHEETS_KEY/DOKOMADE_SHEETS_ID are unset")
    ok = false
  }
  if (!notion && !sheets) return true
  if (!ok) {
    process.exitCode = 1
    return false
  }

  console.log(`sync: ${rows.length} unpushed row(s)`)
  const results = await Promise.allSettled([
    notion ? syncNotion(rows, notion) : Promise.resolve(null),
    sheets ? syncSheets(rows, sheets) : Promise.resolve(null),
  ])
  for (const outcome of results) {
    if (outcome.status === "rejected") {
      console.error(`sync: ${String(outcome.reason)}`)
      process.exitCode = 1
      ok = false
      continue
    }
    if (!outcome.value) continue
    report(outcome.value)
    if (outcome.value.failed > 0) {
      process.exitCode = 1
      ok = false
    }
  }
  return ok
}
