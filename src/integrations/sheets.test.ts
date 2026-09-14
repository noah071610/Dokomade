import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SyncRow } from "../core/markdown.js"
import { syncSheets } from "./sheets.js"

const row = (over: Partial<SyncRow> = {}): SyncRow => ({
  date: "2026-09-14",
  time: "18:35",
  summary: "로그 연동 정리",
  goal: "팀 기록을 한곳에서 확인",
  files: [{ path: "src/integrations/sheets.ts", added: 20, removed: 3 }],
  duration: "42s",
  agent: "codex",
  author: "Noah",
  scope: "Core",
  status: "commit",
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe("syncSheets", () => {
  it("creates the author's tab and appends one batched ten-column payload", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url.includes("oauth2.googleapis.com/token")) return new Response('{"access_token":"token"}', { status: 200 })
      if (url.includes("?fields=")) return new Response('{"sheets":[]}', { status: 200 })
      return new Response("{}", { status: 200 })
    })

    const result = await syncSheets(
      [row()],
      {
        key: JSON.stringify({ client_email: "dokomade@example.iam.gserviceaccount.com", private_key: key }),
        spreadsheet: "sheet123",
        tabPrefix: "",
      },
    )

    expect(result).toMatchObject({ service: "sheets", sent: 1, failed: 0, errors: [] })
    expect(requests).toHaveLength(4)
    expect(requests[2]?.init?.body).toContain('"title":"noah"')
    const body = JSON.parse(String(requests[3]?.init?.body)) as { values: unknown[][] }
    expect(body.values[0]).toEqual(["Date", "Time", "Task", "Goal", "Files", "Lines", "Duration", "AI", "Scope", "Status"])
    expect(body.values[1]).toEqual([
      "2026-09-14",
      "18:35",
      "로그 연동 정리",
      "팀 기록을 한곳에서 확인",
      "src/integrations/sheets.ts +20/-3",
      17,
      "42s",
      "codex",
      "Core",
      "commit",
    ])
    expect(requests[3]?.url).toContain("noah!A%3AJ")
    expect(requests[3]?.url).toContain("valueInputOption=RAW")
  })
})
