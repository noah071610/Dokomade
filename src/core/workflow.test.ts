import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveRev } from "./git.js"
import { WORKFLOW_FILE, writeWorkflow } from "./workflow.js"

const ZERO_SHA = "0".repeat(40)

function repoWithTwoCommits(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-wf-")))
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" })
  }
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(root, `${n}.txt`), `${n}\n`)
    git("add", "-A")
    git("commit", "-q", "-m", `c${n}`)
  }
  return root
}

describe("resolveRev", () => {
  it("resolves a real revision and rejects the shas CI passes on a first push", () => {
    const root = repoWithTwoCommits()
    expect(resolveRev(root, "HEAD~1")).toMatch(/^[0-9a-f]{40}$/)
    // Both would otherwise fall through to the empty tree and re-send the
    // whole log as duplicate pages.
    expect(resolveRev(root, ZERO_SHA)).toBeNull()
    expect(resolveRev(root, "")).toBeNull()
  })
})

describe("writeWorkflow", () => {
  it("writes once, watches the configured log dir, and passes the pushed range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-wfw-"))
    expect(writeWorkflow(root, "logs/work")).toBe(true)
    // Unchanged input must not report a change: `connect` tells the user to
    // commit the file only when there is something new to commit.
    expect(writeWorkflow(root, "logs/work")).toBe(false)

    const yaml = fs.readFileSync(path.join(root, WORKFLOW_FILE), "utf8")
    expect(yaml).toContain('- "logs/work/**"')
    expect(yaml).toContain("fetch-depth: 0")
    expect(yaml).toContain('sync --since "${{ github.event.before }}"')
    expect(yaml).toContain("DOKOMADE_NOTION_TOKEN: ${{ secrets.DOKOMADE_NOTION_TOKEN }}")

    expect(writeWorkflow(root, "docs/dokomade")).toBe(true)
  })
})
