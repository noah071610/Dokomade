import { afterEach, describe, expect, it, vi } from "vitest"
import type { SyncRow } from "../core/markdown.js"
import { syncNotion } from "./notion.js"

const ENV = { token: "ntn_test", database: "db123" }

const row = (over: Partial<SyncRow> = {}): SyncRow => ({
  date: "2026-09-09",
  time: "18:35",
  summary: "자기 의존성 제거",
  files: [
    { path: "package.json", added: 14, removed: 3 },
    { path: "package-lock.json", added: 0, removed: 18 },
  ],
  duration: "42s",
  agent: "codex",
  author: "Noah Jang",
  status: "stage",
  ...over,
})

/** Stub fetch and hand back every request body it was given. */
function stubFetch(reply: () => Response): { bodies: Record<string, any>[] } {
  const bodies: Record<string, any>[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return reply()
  })
  return { bodies }
}

const ok = (): Response => new Response("{}", { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe("syncNotion", () => {
  it("sends one page per row with the properties the database expects", async () => {
    const { bodies } = stubFetch(ok)
    const result = await syncNotion([row()], ENV)

    expect(result).toMatchObject({ service: "notion", sent: 1, failed: 0, errors: [] })
    const body = bodies[0]!
    expect(body.parent).toEqual({ database_id: "db123" })
    expect(body.properties.Task.title[0].text.content).toBe("자기 의존성 제거")
    // Naive local time: the row records when the developer worked.
    expect(body.properties.Date.date.start).toBe("2026-09-09T18:35:00")
    expect(body.properties.Lines.rich_text[0].text.content).toBe("+14/-21")
    expect(body.properties.Files.rich_text[0].text.content).toBe(
      "package.json +14/-3\npackage-lock.json +0/-18",
    )
    expect(body.properties.AI.select).toEqual({ name: "codex" })
    expect(body.properties.Status.select).toEqual({ name: "stage" })
    expect(body.properties.Scope.rich_text[0].text.content).toBe("Etc")
    expect(Object.keys(body.properties).at(-2)).toBe("Author")
    expect(Object.keys(body.properties).at(-1)).toBe("Date")
  })

  it("sends Scope as text for AI-selected combinations", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row({ scope: "Frontend,Backend" })], ENV)
    expect(bodies[0]!.properties.Scope.rich_text[0].text.content).toBe("Frontend,Backend")
  })

  it("puts goal in its own Goal column, not in the title", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row({ goal: "번들 크기 축소" })], ENV)
    expect(bodies[0]!.properties.Task.title[0].text.content).toBe("자기 의존성 제거")
    expect(bodies[0]!.properties.Goal.rich_text[0].text.content).toBe("번들 크기 축소")
  })

  it("sends a placeholder Goal for a row without a goal", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row()], ENV)
    expect(bodies[0]!.properties.Goal.rich_text[0].text.content).toBe("-")
  })

  it("clears a select rather than creating '-' as an option name", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row({ agent: "-" })], ENV)
    expect(bodies[0]!.properties.AI.select).toBeNull()
  })

  it("falls back to a date without a time when the time cell is unusable", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row({ time: "-" })], ENV)
    expect(bodies[0]!.properties.Date.date.start).toBe("2026-09-09")
  })

  it("clips text past Notion's 2000-character limit instead of failing the row", async () => {
    const { bodies } = stubFetch(ok)
    await syncNotion([row({ summary: "가".repeat(2500) })], ENV)
    expect(bodies[0]!.properties.Task.title[0].text.content).toHaveLength(2000)
  })

  it("pulls the id out of a pasted database URL", async () => {
    const { bodies } = stubFetch(ok)
    const id = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
    await syncNotion([row()], { token: "t", database: `https://notion.so/workspace/${id}?v=xyz` })
    expect(bodies[0]!.parent.database_id).toBe(id)
  })

  it("reports a failed row and keeps sending the rest", async () => {
    let call = 0
    stubFetch(() =>
      ++call === 1
        ? new Response('{"message":"Lines is expected to be rich_text."}', { status: 400 })
        : ok(),
    )
    const result = await syncNotion([row(), row({ time: "19:00" })], ENV)

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toContain("400")
    expect(result.errors[0]).toContain("Lines is expected to be rich_text.")
  })
})
