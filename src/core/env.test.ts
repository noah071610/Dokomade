import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadEnvFile, writeEnvFile } from "./env.js"

const keys = ["DOKOMADE_NOTION_TOKEN", "DOKOMADE_NOTION_DB"] as const
const previous = new Map<string, string | undefined>()

beforeEach(() => {
  previous.clear()
  for (const key of keys) previous.set(key, process.env[key])
})

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("local env file", () => {
  it("writes shell-safe exports and loads them without overriding the shell", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-env-"))
    delete process.env.DOKOMADE_NOTION_TOKEN
    delete process.env.DOKOMADE_NOTION_DB

    writeEnvFile(root, {
      DOKOMADE_NOTION_TOKEN: "ntn_$safe",
      DOKOMADE_NOTION_DB: "db'quoted",
    })

    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain("export DOKOMADE_NOTION_TOKEN='")
    expect(fs.statSync(path.join(root, ".env")).mode & 0o777).toBe(0o600)
    loadEnvFile(root)
    expect(process.env.DOKOMADE_NOTION_TOKEN).toBe("ntn_$safe")
    expect(process.env.DOKOMADE_NOTION_DB).toBe("db'quoted")

    process.env.DOKOMADE_NOTION_TOKEN = "shell-wins"
    loadEnvFile(root)
    expect(process.env.DOKOMADE_NOTION_TOKEN).toBe("shell-wins")
  })
})
