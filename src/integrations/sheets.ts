import { createSign } from "node:crypto"
import type { SheetsEnv } from "../core/env.js"
import type { SyncRow } from "../core/markdown.js"
import { totalDelta } from "../core/markdown.js"
import type { SyncResult } from "./types.js"

interface ServiceAccount {
  client_email?: string
  private_key?: string
}

interface SpreadsheetInfo {
  sheets?: Array<{ properties?: { title?: string } }>
}

const HEADER = ["Date", "Time", "Task", "Goal", "Files", "Lines", "Duration", "AI", "Scope", "Status"]
const base64url = (value: string): string => Buffer.from(value).toString("base64url")
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function spreadsheetId(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? value
}

function tabName(author: string, prefix: string): string {
  const safe = author
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "unknown"
  const cleanPrefix = prefix.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "")
  return `${cleanPrefix ? `${cleanPrefix}-` : ""}${safe}`.slice(0, 100)
}

function signedAssertion(account: ServiceAccount): string {
  if (!account.client_email || !account.private_key) throw new Error("invalid Google service-account JSON")
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )
  const input = `${header}.${payload}`
  const sign = createSign("RSA-SHA256")
  sign.update(input)
  return `${input}.${sign.sign(account.private_key, "base64url")}`
}

async function accessToken(account: ServiceAccount): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signedAssertion(account),
  })
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!response.ok) throw new Error(`Google OAuth HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) throw new Error("Google OAuth response did not contain an access token")
  return data.access_token
}

async function request(make: () => Promise<Response>): Promise<Response> {
  let response: Response | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await make()
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) return response
    const retryAfter = Number(response.headers.get("retry-after"))
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 16000))
  }
  return response as Response
}

async function apiError(response: Response): Promise<Error> {
  return new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
}

function values(row: SyncRow): unknown[] {
  const delta = totalDelta(row.files)
  return [
    row.date,
    row.time,
    row.summary,
    row.goal ?? "-",
    row.files.map((f) => `${f.path} +${f.added}/-${f.removed}`).join("\n"),
    delta.added - delta.removed,
    row.duration,
    row.agent,
    row.scope ?? "Etc",
    row.status,
  ]
}

async function existingTabs(id: string, token: string): Promise<Set<string>> {
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties.title`
  const response = await request(() =>
    fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } }),
  )
  if (!response.ok) throw await apiError(response)
  const data = (await response.json()) as SpreadsheetInfo
  return new Set(data.sheets?.map((sheet) => sheet.properties?.title).filter((title): title is string => Boolean(title)))
}

async function createTabs(id: string, token: string, names: string[]): Promise<void> {
  if (names.length === 0) return
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`
  const response = await request(() =>
    fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: names.map((title) => ({ addSheet: { properties: { title } } })) }),
    }),
  )
  if (!response.ok) throw await apiError(response)
}

export async function syncSheets(rows: SyncRow[], env: SheetsEnv): Promise<SyncResult> {
  const result: SyncResult = { service: "sheets", sent: 0, failed: 0, errors: [] }
  let token: string
  try {
    token = await accessToken(JSON.parse(env.key) as ServiceAccount)
  } catch (error) {
    result.failed = rows.length
    result.errors.push(String(error))
    return result
  }

  const groups = new Map<string, SyncRow[]>()
  for (const row of rows) {
    const tab = tabName(row.author, env.tabPrefix)
    groups.set(tab, [...(groups.get(tab) ?? []), row])
  }

  try {
    const id = spreadsheetId(env.spreadsheet)
    const existing = await existingTabs(id, token)
    const missing = [...groups.keys()].filter((name) => !existing.has(name))
    await createTabs(id, token, missing)

    // ponytail: append-only라 응답 유실 시 중복 가능; 정확히 한 번 필요하면 destination ID 추가.
    for (const [tab, tabRows] of groups) {
      const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(`${tab}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
      const response = await request(() =>
        fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [ ...(missing.includes(tab) ? [HEADER] : []), ...tabRows.map(values) ] }),
        }),
      )
      if (!response.ok) throw await apiError(response)
      result.sent += tabRows.length
    }
  } catch (error) {
    result.failed = rows.length - result.sent
    result.errors.push(String(error))
  }
  return result
}
