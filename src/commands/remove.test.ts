import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { remove } from "./remove.js"

const ours = (file: string): { type: string; command: string } => ({
  type: "command",
  command: `node "/x/node_modules/dokomade/dist/hooks/${file}"`,
})

/** A project carrying dokomade's hooks plus hooks nobody else may touch. */
function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-rm-")))
  fs.mkdirSync(path.join(root, ".dokomade"), { recursive: true })
  fs.writeFileSync(path.join(root, ".dokomade", "config.json"), JSON.stringify({ logDir: "docs/dokomade" }))

  fs.mkdirSync(path.join(root, ".claude"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        Stop: [{ hooks: [ours("on-stop.js")] }, { hooks: [{ type: "command", command: "node ./mine.js" }] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [ours("on-tool.js")] }],
      },
    }),
  )

  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".cursor", "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [ours("on-stop.js")], afterFileEdit: [ours("on-tool.js")] } }),
  )

  fs.mkdirSync(path.join(root, "docs", "dokomade", "t"), { recursive: true })
  fs.writeFileSync(path.join(root, "docs", "dokomade", "t", "2026-09-16.md"), "# log\n")
  return root
}

describe("remove", () => {
  it("strips only dokomade's hooks and keeps the logs", async () => {
    const root = project()
    await remove({ yes: true }, root)

    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")) as {
      permissions: { allow: string[] }
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    // Someone else's settings and someone else's hook both survive.
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"])
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe("node ./mine.js")
    // The event held only our group, so the event goes with it.
    expect(settings.hooks.PostToolUse).toBeUndefined()

    // A file that was purely ours leaves no husk behind.
    expect(fs.existsSync(path.join(root, ".cursor", "hooks.json"))).toBe(false)
    expect(fs.existsSync(path.join(root, ".dokomade"))).toBe(false)
    // The logs are history, not state: they stay until asked for.
    expect(fs.existsSync(path.join(root, "docs", "dokomade", "t", "2026-09-16.md"))).toBe(true)
  })

  it("deletes the logs only when asked", async () => {
    const root = project()
    await remove({ yes: true, logs: true }, root)
    expect(fs.existsSync(path.join(root, "docs", "dokomade"))).toBe(false)
  })
})
