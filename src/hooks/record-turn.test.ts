import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { appendJSONL, paths, writeJSON } from "../core/store.js"
import { recordTurn } from "./record-turn.js"

describe("recordTurn", () => {
  it("recovers a turn when Stop did not run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dokomade-"))
    execFileSync("git", ["init", "-q", root])
    fs.mkdirSync(path.join(root, "src"))
    fs.writeFileSync(path.join(root, "src", "changed.ts"), "export const changed = true;\n")
    writeJSON(paths(root).config, {
      logDir: "docs/dokomade",
      projectType: "library",
      classify: { frontend: { pageDirs: [], sharedDirs: [] }, backend: { routeDirs: [] } },
      commit: { windowDays: 7, convention: "commit-convention.md", ai: "none", aiConfigured: false },
    })
    writeJSON(paths(root).state, {
      promptStartedAt: Date.now() - 1000,
      sessionId: "old-turn",
      agent: "codex",
    })

    expect(await recordTurn(root, "codex", undefined, "test-recovery", Date.now())).toBe(true)
    const files = fs.readdirSync(path.join(root, "docs", "dokomade")).length
    expect(files).toBeGreaterThan(0)
  })

  it("ignores pending paths outside the project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dokomade-"))
    fs.mkdirSync(path.join(root, ".dokomade"))
    writeJSON(paths(root).config, { logDir: "docs/dokomade" })
    appendJSONL(paths(root).pending, { ts: Date.now(), tool: "Edit", path: "../secret.txt" })

    expect(await recordTurn(root, "codex", undefined, "test-path-boundary", Date.now())).toBe(false)
  })
})
