import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { ART } from "../core/banner.js"
import { init } from "./init.js"

it("비대화형 init 뒤에 공용 로고와 도구별 hook 활성화 안내를 출력한다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-init-")))
  const stdinTTY = process.stdin.isTTY
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  process.stdin.isTTY = false
  try {
    await init(root, "library")

    const output = log.mock.calls.map((args) => args.join(" ")).join("\n")
    for (const line of ART) expect(output).toContain(line)
    expect(output.indexOf(ART[0]!)).toBeGreaterThan(output.indexOf("Configuration complete!"))
    expect(output).toContain("Codex — manual approval required")
    expect(output).toContain("project trust prompt")
    expect(output).toContain("/hooks")
    expect(output).toContain("review/trust the dokomade commands (hooks/on-*.js)")
    expect(output).toContain("Untrusted hooks are skipped")
    expect(output).toContain("Restart Claude Code; accept workspace trust")
    expect(output).toContain("Customize > Hooks")
    expect(output).toContain("it does not approve trust on your behalf")
    expect(output).not.toContain("--dangerously-bypass")
    for (const file of [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"]) {
      expect(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).hooks).toBeDefined()
    }
  } finally {
    process.stdin.isTTY = stdinTTY
    log.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
