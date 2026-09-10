import { createSign } from "node:crypto"
import type { SheetsEnv } from "../core/env.js"
import type { SyncRow } from "../core/markdown.js"
import { totalDelta } from "../core/markdown.js"
import type { SyncResult } from "./types.js"

interface ServiceAccount {
  client_email?: string
  private_key?: string
}

const base64url = (value: string): string => Buffer.from(value).toString("base64url")

function spreadsheetId(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? value
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

function values(row: SyncRow): unknown[] {
  const delta = totalDelta(row.files)
  return [
    row.date,
    row.time,
    row.summary,
    row.files.map((f) => `${f.path} +${f.added}/-${f.removed}`).join("\n"),
    delta.added - delta.removed,
    row.duration,
    row.agent,
    row.author,
    row.status,
  ]
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

  const range = `${env.tab}!A:I`
  for (const row of rows) {
    try {
      const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId(env.spreadsheet))}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [values(row)] }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
      result.sent++
    } catch (error) {
      result.failed++
      result.errors.push(`${row.date} ${row.time}: ${String(error)}`)
    }
  }
  return result
}
