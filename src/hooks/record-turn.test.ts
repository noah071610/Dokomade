import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordTurn } from "./record-turn.js";
import { writeJSON, paths } from "../core/store.js";

describe("recordTurn", () => {
  it("recovers a turn when Stop did not run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dokomade-"));
    execFileSync("git", ["init", "-q", root]);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "changed.ts"), "export const changed = true;\n");
    writeJSON(paths(root).config, {
      logDir: "docs/dokomade",
      projectType: "library",
      classify: { frontend: { pageDirs: [], sharedDirs: [] }, backend: { routeDirs: [] } },
      commit: { windowDays: 7, convention: "commit-convention.md", ai: "none", aiConfigured: false },
      integrations: { notion: false, slack: false, sheets: false },
    });
    writeJSON(paths(root).state, {
      promptStartedAt: Date.now() - 1000,
      sessionId: "old-turn",
      agent: "codex",
    });

    expect(await recordTurn(root, "codex", undefined, "test-recovery", Date.now())).toBe(true);
    const files = fs.readdirSync(path.join(root, "docs", "dokomade")).length;
    expect(files).toBeGreaterThan(0);
  });
});

// [dokomade] 누락 턴 회수 검증
