/**
 * Notion sync: one log row becomes one page in the user's database.
 *
 * No SDK. `@notionhq/client` would be a dependency, a bundle, and a version to
 * keep current in exchange for wrapping one POST - and src/hooks/* would pay
 * its import cost if anything ever imported this directory by accident.
 *
 * The database must carry these properties:
 *
 *   Task (title) · Goal (text) · Files (text) · Lines (text) · Duration (text)
 *   AI (select) · Scope (text) · Status (select) · Author (text) · Date (date)
 *
 * Notion creates missing select options itself, so AI and Status need no
 * setup; a property that is missing or the wrong type fails that row with the
 * API's own message, which names the property.
 */
import type { NotionEnv } from "../core/env.js"
import type { SyncRow } from "../core/markdown.js"
import { totalDelta } from "../core/markdown.js"
import type { SyncResult } from "./types.js"

const ENDPOINT = "https://api.notion.com/v1/pages"
const NOTION_VERSION = "2022-06-28"
/** Notion rejects a title or rich_text value past 2000 characters. */
const TEXT_LIMIT = 2000
/** The documented average is 3 requests/second. */
const GAP_MS = 350

/** A pasted database URL carries the id as 32 hex digits somewhere inside it. */
function databaseId(value: string): string {
  const match = value.replaceAll("-", "").match(/[0-9a-f]{32}/i)
  return match ? match[0] : value
}

const clip = (value: string): string => value.slice(0, TEXT_LIMIT) || "-"

const text = (value: string) => ({ rich_text: [{ text: { content: clip(value) } }] })

/**
 * A select needs a real option name; "-" is the log's own placeholder for
 * "unknown" and would otherwise be created as an option in the database.
 */
const select = (value: string) =>
  value && value !== "-" ? { select: { name: clip(value) } } : { select: null }

/**
 * Naive local time, matching the log: the row records when the developer
 * worked, and shifting it into UTC would move late-night rows a day back.
 * The log stores HH:MM, so the seconds are always :00 - a row whose time cell
 * is missing or malformed falls back to a date without a time rather than
 * failing the whole page on an unparseable value.
 */
function startedAt(row: SyncRow): string {
  return /^\d{2}:\d{2}$/.test(row.time) ? `${row.date}T${row.time}:00` : row.date
}

function properties(row: SyncRow): Record<string, unknown> {
  const delta = totalDelta(row.files)
  const properties: Record<string, unknown> = {
    Task: { title: [{ text: { content: clip(row.summary) } }] },
    // What changed and its goal are separate questions, so they get
    // separate columns: a title crammed with both is harder to scan, and the
    // goal is the half a reader filters on.
    Goal: text(row.goal ?? ""),
    Files: text(row.files.map((f) => `${f.path} +${f.added}/-${f.removed}`).join("\n")),
    Lines: text(`+${delta.added}/-${delta.removed}`),
    Duration: text(row.duration),
    AI: select(row.agent),
    Scope: text(row.scope ?? "Etc"),
    Status: select(row.status),
    Author: text(row.author),
    Date: { date: { start: startedAt(row) } },
  }
  return properties
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Send every row, one page each.
 *
 * A failed row is reported and the rest still go: a single malformed summary
 * must not cost the whole push its log. The caller turns any failure into a
 * non-zero exit so CI goes red rather than quietly dropping rows.
 */
export async function syncNotion(rows: SyncRow[], env: NotionEnv): Promise<SyncResult> {
  const result: SyncResult = { service: "notion", sent: 0, failed: 0, errors: [] }
  const database = databaseId(env.database)

  for (const [i, row] of rows.entries()) {
    if (i > 0) await sleep(GAP_MS)
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({ parent: { database_id: database }, properties: properties(row) }),
      })
      if (!response.ok) {
        // The body names the offending property on a schema mismatch, which is
        // the failure this hits most; 400 characters is enough to carry it.
        const body = (await response.text()).slice(0, 400)
        result.failed++
        result.errors.push(`${row.date} ${row.time}: ${response.status} ${body}`)
        continue
      }
      result.sent++
    } catch (error) {
      result.failed++
      result.errors.push(`${row.date} ${row.time}: ${(error as Error).message}`)
    }
  }

  return result
}
