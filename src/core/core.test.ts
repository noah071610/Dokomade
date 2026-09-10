import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CLOSE_MARK, extractMessage, OPEN_MARK } from "./ai.js"
import { classify, classifyAll, normalizeScope, SHARED_LABEL } from "./classify.js"
import { authorName, changedSince } from "./git.js"
import {
  appendRow,
  formatDuration,
  formatFiles,
  formatRow,
  logPath,
  parseSyncRow,
  recentLogFiles,
  rowsWithStatus,
  setStatus,
  splitCells,
  statusOf,
  timeKey,
  upgradeHeader,
  withStatus,
} from "./markdown.js"
import {
  DEFAULT_CONFIG,
  defaultLogDir,
  findRoot,
  paths,
  readConfig,
  repoRelativePath,
  writeConfig,
  writeJSON,
  workspaceRepositories,
} from "./store.js"
import { MechanicalSummarizer } from "./summarize.js"

const cfg = DEFAULT_CONFIG.classify

describe("classify", () => {
  it("normalizes AI scope tokens and rejects arbitrary text", () => {
    expect(normalizeScope("Backend, Frontend")).toBe("Frontend,Backend")
    expect(normalizeScope("Frontend,Core")).toBe("Frontend,Core")
    expect(normalizeScope("Etc,Frontend")).toBe("Etc")
    expect(normalizeScope("Frontend work")).toBe("Etc")
  })

  it("maps a frontend file to its page, not its component", () => {
    expect(classify("src/app/calculator/page.tsx", cfg)).toBe("calculator")
    expect(classify("src/app/calculator/bottom-sheet.tsx", cfg)).toBe("calculator")
  })

  it("maps a backend file to its REST domain", () => {
    expect(classify("src/api/users/route.ts", cfg)).toBe("users")
  })

  it("uses the project root when a single-stack config has a root marker", () => {
    expect(
      classify("src/app/page.tsx", {
        frontend: { pageDirs: ["."], sharedDirs: [] },
        backend: { routeDirs: [] },
      }),
    ).toBe("src")
  })

  it("buckets shared components separately from pages", () => {
    expect(classify("src/components/main-header.tsx", cfg)).toBe(SHARED_LABEL)
  })

  it("strips the extension when the page is a bare file", () => {
    expect(classify("src/pages/settings.tsx", cfg)).toBe("settings")
  })

  it("falls back to the parent directory for unconfigured paths", () => {
    expect(classify("src/i18n/ko.json", cfg)).toBe("i18n")
  })

  it("orders labels by how many files each covers", () => {
    expect(
      classifyAll(["src/api/users/route.ts", "src/app/calculator/page.tsx", "src/app/calculator/x.tsx"], cfg),
    ).toEqual(["calculator", "users"])
  })

})

describe("config", () => {
  it("accepts library and extension projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-config-"))
    fs.mkdirSync(path.join(root, ".dokomade"))
    writeJSON(paths(root).config, { projectType: "library" })

    expect(readConfig(paths(root)).projectType).toBe("library")
  })

  it("writes and reads a strict JSON config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-config-"))
    const p = paths(root)
    const written = {
      ...DEFAULT_CONFIG,
      // A value carrying `//` inside a string: the comment stripper must keep it.
      logDir: "https://example.com/logs",
      commit: { ...DEFAULT_CONFIG.commit, ai: "claude" as const, aiConfigured: true },
    }
    writeConfig(p, written)

    expect(() => JSON.parse(fs.readFileSync(p.config, "utf8"))).not.toThrow()
    expect(readConfig(p)).toEqual(written)
  })

  it("falls back when config paths escape the project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-config-"))
    const p = paths(root)
    writeJSON(p.config, {
      logDir: "../../outside",
      commit: { convention: "../secret.txt" },
    })

    const config = readConfig(p)
    expect(config.logDir).toBe(DEFAULT_CONFIG.logDir)
    expect(config.commit.convention).toBe(DEFAULT_CONFIG.commit.convention)
  })
})

describe("markdown", () => {
  it("renders the file cell as basename +add/-del joined by <br>", () => {
    expect(
      formatFiles([
        { path: "src/app/calculator/page.tsx", added: 42, removed: 13 },
        { path: "src/i18n/ko.json", added: 24, removed: 0 },
      ]),
    ).toBe("`page.tsx` +42/-13<br>`ko.json` +24/-0")
  })

  it("formats durations by magnitude", () => {
    expect(formatDuration(35_000)).toBe("35s")
    expect(formatDuration(4 * 60_000)).toBe("4m")
    expect(formatDuration(62 * 60_000)).toBe("1h2m")
    expect(formatDuration(-1)).toBe("-")
  })

  it("escapes pipes so a summary cannot break the table", () => {
    const row = formatRow({
      at: new Date(2026, 8, 6, 14, 11),
      summary: "a | b",
      files: [{ path: "x.ts", added: 1, removed: 0 }],
      durationMs: 4 * 60_000,
      author: "noah",
    })
    expect(row).toBe("| 14:11 | a \\| b |  | `x.ts` +1/-0 | 4m | - | Etc | stage | noah | 2026-09-06T14:11:00 |")
    // Cell delimiters are the unescaped pipes: 10 columns -> 11 delimiters.
    expect(row.replace(/\\\|/g, "").split("|").length - 1).toBe(11)
    // An escaped pipe must not shift Status or Author into the wrong slot.
    expect(splitCells(row)).toHaveLength(10)
    expect(statusOf(row)).toBe("stage")
  })

  it("separates Goal and keeps Author immediately before Date", () => {
    const row = formatRow({
      at: new Date(2026, 8, 6, 14, 11),
      summary: "API and page",
      files: [],
      durationMs: -1,
      author: "noah",
      scope: "Frontend,Backend",
    })
    expect(splitCells(row)).toEqual([
      "14:11",
      "API and page",
      "",
      "-",
      "-",
      "-",
      "Frontend,Backend",
      "stage",
      "noah",
      "2026-09-06T14:11:00",
    ])
    expect(parseSyncRow(row, "docs/dokomade/noah/2026-09-06.md")?.scope).toBe("Frontend,Backend")
  })
})

describe("MechanicalSummarizer", () => {
  const s = new MechanicalSummarizer()
  // Most cases only care about the first line; `goal` has its own tests below.
  const title = async (input: Parameters<typeof s.summarize>[0]): Promise<string> =>
    (await s.summarize(input)).summary

  it("takes the line the assistant tagged", async () => {
    expect(
      await title({
        labels: ["vocab"],
        files: [],
        lastAssistantMessage: "원인 찾았습니다.\n\n[summary] 어휘카드 뒤로가기 수정",
      }),
    ).toBe("어휘카드 뒤로가기 수정")
  })

  it("takes the last tag when the assistant also explains the convention", async () => {
    expect(
      await title({
        labels: [],
        files: [],
        lastAssistantMessage: "형식은 `[summary] <제목>` 입니다.\n- [summary] 로그인 폼 검증 추가",
      }),
    ).toBe("로그인 폼 검증 추가")
  })

  it("keeps goal as its own line", async () => {
    expect(
      await s.summarize({
        labels: [],
        files: [],
        lastAssistantMessage: "[summary] init --default 플래그 추가\n[goal] CI에서 대화형 프롬프트 없이 초기화하려고\n[scope] Core",
      }),
    ).toEqual({ summary: "init --default 플래그 추가", goal: "CI에서 대화형 프롬프트 없이 초기화하려고", scope: "Core" })
  })

  it("leaves goal absent when the reply only tagged a title", async () => {
    expect(
      await s.summarize({ labels: [], files: [], lastAssistantMessage: "[summary] 로그인 폼 검증 추가" }),
    ).toEqual({ summary: "로그인 폼 검증 추가", goal: undefined, scope: "Etc" })
  })

  it("keeps a detailed title whole rather than cutting it at 40", async () => {
    const detailed = "Notion 연동의 Lines·AI 속성 타입을 텍스트와 셀렉트로 되돌리고 전송 간격 추가"
    expect(await title({ labels: [], files: [], lastAssistantMessage: `[summary] ${detailed}` })).toBe(detailed)
  })

  it("cuts a title that overshoots the ceiling", async () => {
    const summary = await title({
      labels: [],
      files: [],
      lastAssistantMessage: `[summary] ${"가".repeat(150)}`,
    })
    expect(summary).toHaveLength(100)
    expect(summary.endsWith("…")).toBe(true)
  })

  it("never leaves a <br> in the cell, since it is the Task separator", async () => {
    expect(
      await title({ labels: [], files: [], lastAssistantMessage: "[summary] 훅 등록<br>경로 정리" }),
    ).toBe("훅 등록 경로 정리")
  })

  it("never leaves a newline in the cell", async () => {
    expect(
      await title({ labels: [], files: [], lastAssistantMessage: "[summary] 훅 등록\n경로 정리" }),
    ).not.toContain("\n")
  })

  it("never invents a goal for an untagged turn", async () => {
    // The fallbacks guess at what changed; a motive cannot be guessed at all.
    expect(
      await s.summarize({
        labels: [],
        files: [{ path: "src/auth/login.ts", added: 1, removed: 0 }],
        lastAssistantMessage: "고쳤습니다.",
      }),
    ).toEqual({ summary: "login 변경", scope: "Etc" })
  })

  it("falls back to what the assistant said, stripped of markdown", async () => {
    expect(
      await title({
        labels: ["auth"],
        files: [],
        lastAssistantMessage: "**로그인 리다이렉트 수정**했습니다. `auth.ts`를 고쳤어요.",
      }),
    ).toBe("로그인 리다이렉트 수정")
  })

  it("strips IDE context blocks the assistant quoted back", async () => {
    expect(
      await title({
        labels: ["vite.config"],
        files: [],
        lastAssistantMessage:
          "<ide_opened_file>The user opened the file /x/vite.config.ts in the IDE.</ide_opened_file>\n[summary] 어휘카드 뒤로가기 추가",
      }),
    ).toBe("어휘카드 뒤로가기 추가")
  })

  it("never titles a row from the prompt", async () => {
    // The request is not the work: an untagged turn falls through to labels
    // rather than echoing whatever the user typed.
    expect(
      await title({
        labels: ["users"],
        files: [],
        lastAssistantMessage: "<ide_opened_file>The user opened a file</ide_opened_file>",
      }),
    ).toBe("users")
  })

  it("falls back to labels when there is nothing else", async () => {
    expect(await title({ labels: ["users"], files: [] })).toBe("users")
  })

  it("skips generic acknowledgements and uses the changed file", async () => {
    expect(
      await title({
        labels: [],
        files: [{ path: "src/auth/login.ts", added: 1, removed: 0 }],
        lastAssistantMessage: "고쳤습니다.",
      }),
    ).toBe("login 변경")
  })

  it("rejects a generic tagged title too", async () => {
    expect(
      await title({
        labels: [],
        files: [{ path: "src/auth/login.ts", added: 1, removed: 0 }],
        lastAssistantMessage: "[summary] 수정",
      }),
    ).toBe("login 변경")
  })

  it("has a title even with no labels", async () => {
    expect(await title({ labels: [], files: [] })).toBe("파일 수정")
  })
})

describe("findRoot boundaries", () => {
  const mk = (...segs: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-"))
    const deep = path.join(dir, ...segs)
    fs.mkdirSync(deep, { recursive: true })
    return dir
  }

  it("finds .dokomade from a nested subdirectory", () => {
    const root = mk("packages", "web", "src")
    fs.mkdirSync(path.join(root, ".dokomade"))
    expect(fs.realpathSync(findRoot(path.join(root, "packages/web/src"))!)).toBe(fs.realpathSync(root))
  })

  it("lets a parent workspace own an initialized child repo", () => {
    const outer = mk("inner", "src")
    fs.mkdirSync(path.join(outer, ".dokomade"))
    fs.mkdirSync(path.join(outer, "inner", ".git"))
    expect(fs.realpathSync(findRoot(path.join(outer, "inner/src"))!)).toBe(fs.realpathSync(outer))
  })

  it("prefers the top-level init over one left behind in a subfolder", () => {
    // frontend initialised first, then wrapped in a parent that was initialised too
    const parent = mk("frontend", "src")
    fs.mkdirSync(path.join(parent, ".dokomade"))
    fs.mkdirSync(path.join(parent, "frontend", ".dokomade"))
    expect(fs.realpathSync(findRoot(path.join(parent, "frontend/src"))!)).toBe(fs.realpathSync(parent))

    // ...even when the frontend kept its own repo
    fs.mkdirSync(path.join(parent, "frontend", ".git"))
    fs.writeFileSync(path.join(parent, "package.json"), "{}")
    expect(fs.realpathSync(findRoot(path.join(parent, "frontend/src"))!)).toBe(fs.realpathSync(parent))
  })

  it("lets the parent win even when it has no package.json", () => {
    const projects = mk("app", "src")
    fs.mkdirSync(path.join(projects, ".dokomade"))
    fs.mkdirSync(path.join(projects, "app", ".dokomade"))
    fs.mkdirSync(path.join(projects, "app", ".git"))
    expect(fs.realpathSync(findRoot(path.join(projects, "app/src"))!)).toBe(fs.realpathSync(projects))
  })

  it("does not discover child installs when the parent is not initialized", () => {
    const parent = mk("frontend", "src")
    fs.mkdirSync(path.join(parent, "frontend", ".dokomade"))
    fs.mkdirSync(path.join(parent, "frontend", ".git"))
    expect(findRoot(parent)).toBeNull()
  })
})

describe("workspace repositories", () => {
  it("registers direct child Git repositories under a non-Git workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-workspace-"))
    for (const name of ["frontend", "backend"]) {
      const repo = path.join(root, name)
      fs.mkdirSync(repo)
      execFileSync("git", ["-C", repo, "init", "-q"])
    }

    expect(workspaceRepositories(root).map((repo) => [repo.name, repo.relative])).toEqual([
      ["backend", "backend"],
      ["frontend", "frontend"],
    ])
  })
})

describe("defaultLogDir", () => {
  const pkg = (dir: string, deps: Record<string, string> = {}): void => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: deps }))
  }
  const mono = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-logdir-"))
    pkg(root)
    pkg(path.join(root, "apps/web"), { dokomade: "1.0.0" })
    pkg(path.join(root, "apps/api"))
    // an installed copy under node_modules is not a package that installs dokomade
    pkg(path.join(root, "node_modules/some-dep"), { dokomade: "1.0.0" })
    return root
  }

  it("logs next to the only package that installs dokomade", () => {
    expect(defaultLogDir(mono())).toBe("apps/web/docs/dokomade")
  })

  it("falls back to the top level when installs are ambiguous", () => {
    const two = mono()
    pkg(path.join(two, "apps/api"), { dokomade: "1.0.0" })
    expect(defaultLogDir(two)).toBe("docs/dokomade")

    const atRoot = mono()
    pkg(atRoot, { dokomade: "1.0.0" })
    expect(defaultLogDir(atRoot)).toBe("docs/dokomade")

    const leftover = mono()
    fs.mkdirSync(path.join(leftover, "apps/web/.dokomade"))
    expect(defaultLogDir(leftover)).toBe("docs/dokomade")

    expect(defaultLogDir(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-logdir-")))).toBe("docs/dokomade")
  })
})

describe("repoRelativePath", () => {
  it("rejects paths outside the project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-path-"))
    expect(repoRelativePath(root, path.join(root, "src", "file.ts"))).toBe("src/file.ts")
    expect(repoRelativePath(root, path.join(root, "..", "secret.txt"))).toBeNull()
  })
})

describe("changedSince", () => {
  const repo = (): string => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-gs-")))
    execFileSync("git", ["-C", root, "init", "-q"])
    const ignore = path.join(root, ".gitignore")
    fs.writeFileSync(ignore, "ignored/\n")
    // Backdate the fixture itself so it never lands inside the turn window.
    const old = (Date.now() - 3_600_000) / 1000
    fs.utimesSync(ignore, old, old)
    return root
  }

  const touch = (root: string, rel: string, at: number): void => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, "x\n")
    fs.utimesSync(abs, at / 1000, at / 1000)
  }

  it("sees a file a Bash heredoc rewrote, and ignores one from before the turn", () => {
    const root = repo()
    const turnStart = Date.now()
    touch(root, "stale.ts", turnStart - 60_000)
    touch(root, "src/edited.ts", turnStart + 1_000)

    expect(changedSince(root, turnStart)).toEqual(["src/edited.ts"])
  })

  it("never reports a gitignored path", () => {
    const root = repo()
    const turnStart = Date.now()
    touch(root, "ignored/build.js", turnStart + 1_000)
    touch(root, "kept.ts", turnStart + 1_000)

    expect(changedSince(root, turnStart)).toEqual(["kept.ts"])
  })

  it("returns nothing outside a git repo", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-nogit-"))
    expect(changedSince(bare, 0)).toEqual([])
  })
})

describe("status column", () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-st-"))

  it("treats a row written before the column existed as stage", () => {
    expect(statusOf("| 14:00 | 뭔가 함 | `x.ts` +1/-0 | 2m | noah |")).toBe("stage")
  })

  it("ignores a status cell holding something that is not a status", () => {
    expect(statusOf("| 14:00 | a | - | - | claude | noah | 아무말 |")).toBe("stage")
  })

  it("reads a legacy row's status from where that row actually keeps it", () => {
    expect(statusOf("| 14:00 | a | - | 2m | noah | push |")).toBe("push")
  })

  it("opens the AI gap on a legacy row rather than overwriting Author", () => {
    const row = withStatus("| 14:00 | a | - | 2m | noah |", "commit")
    expect(splitCells(row)).toEqual(["14:00", "a", "", "-", "2m", "", "", "commit", "noah", ""])
  })

  it("replaces an outdated header and widens the rows under it", () => {
    const root = tmp()
    const file = path.join(root, "2026-09-07.md")
    fs.writeFileSync(
      file,
      [
        "# 2026-09-07 - noah",
        "",
        "| 시각  | 안녕바보야 | 파일 | 소요 | 작성자 |",
        "| ----- | ---- | ---- | ---- | ------ |",
        "| 14:00 | a    | -    | 2m   | noah   |",
        "",
      ].join("\n"),
    )
    upgradeHeader(file)
    const lines = fs.readFileSync(file, "utf8").split("\n")
    expect(splitCells(lines[3] as string)).toHaveLength(10)
    // A header is labels, not data: an old or hand-renamed one is replaced.
    expect(splitCells(lines[2] as string)).toEqual(["Time", "Task", "Goal", "Files", "Duration", "AI", "Scope", "Status", "Author", "Date"])
    // The row is migrated too, so noah stays in Author immediately before Date.
    expect(splitCells(lines[4] as string)).toEqual(["14:00", "a", "", "-", "2m", "", "", "", "noah", ""])
  })

  it("splits a previous combined Task row while moving Author before Date", () => {
    const root = tmp()
    const file = path.join(root, "2026-09-07.md")
    fs.writeFileSync(
      file,
      [
        "# 2026-09-07 - noah",
        "",
        "| Time | Task | Files | Duration | AI | Author | Scope | Status | Date |",
        "| ---- | ---- | ----- | -------- | -- | ------ | ----- | ------ | ---- |",
        "| 14:00 | summary<br>goal | - | 2m | codex | noah | Core | commit | 2026-09-07T14:00:00 |",
        "",
      ].join("\n"),
    )
    upgradeHeader(file)
    const row = fs.readFileSync(file, "utf8").split("\n")[4] as string
    expect(splitCells(row)).toEqual([
      "14:00",
      "summary",
      "goal",
      "-",
      "2m",
      "codex",
      "Core",
      "commit",
      "noah",
      "2026-09-07T14:00:00",
    ])
  })

  it("moves only the rows in the requested state, and reports the count", () => {
    const root = tmp()
    const file = path.join(root, "log.md")
    fs.writeFileSync(
      file,
      [
        "| 시각 | 작업 | 파일 | 소요 | 작성자 | 상태 |",
        "| ---- | ---- | ---- | ---- | ------ | ---- |",
        "| 14:00 | a | - | - | noah | stage |",
        "| 14:10 | b | - | - | noah | commit |",
        "| 14:20 | c | - | - | noah | stage |",
        "",
      ].join("\n"),
    )
    expect(setStatus([file], "stage", "commit")).toEqual([{ file, rows: 2 }])
    expect(rowsWithStatus([file], "stage")).toEqual([])
    expect(rowsWithStatus([file], "commit").map((r) => r.time)).toEqual(["14:00", "14:10", "14:20"])
  })

  it("un-escapes the pipe when reading a summary back out", () => {
    const root = tmp()
    const file = path.join(root, "log.md")
    const at = new Date(2026, 8, 7, 14, 0)
    appendRow(file, { at, summary: "a | b", files: [], durationMs: -1, author: "noah" })
    expect(rowsWithStatus([file], "stage")[0]?.summary).toBe("a | b")
  })

  it("writes summary and goal as separate cells", () => {
    const root = tmp()
    const file = path.join(root, "2026-09-07.md")
    const at = new Date(2026, 8, 7, 14, 0)
    appendRow(file, {
      at,
      summary: "훅 등록<br>경로 정리",
      goal: "CI에서<br>깨져서",
      files: [],
      durationMs: -1,
      author: "noah",
    })

    const row = fs.readFileSync(file, "utf8").split("\n").find((l) => l.includes("훅 등록")) as string
    expect(row).not.toContain("<br>")

    const parsed = parseSyncRow(row, file)
    expect(parsed?.summary).toBe("훅 등록 경로 정리")
    expect(parsed?.goal).toBe("CI에서 깨져서")
  })

  it("scans the window, not just today, so an overnight row is still found", () => {
    const root = tmp()
    const now = new Date(2026, 8, 7, 9, 0)
    const yesterday = new Date(2026, 8, 6, 23, 50)
    appendRow(logPath(root, "docs", "noah", yesterday), {
      at: yesterday,
      summary: "밤샘",
      files: [],
      durationMs: -1,
      author: "noah",
    })
    expect(recentLogFiles(root, "docs", "noah", 1, now)).toEqual([])
    const week = recentLogFiles(root, "docs", "noah", 7, now)
    expect(week).toHaveLength(1)
    expect(rowsWithStatus(week, "stage")[0]?.summary).toBe("밤샘")
  })

  it("normalizes author folders and still reads legacy names", () => {
    const root = tmp()
    const at = new Date(2026, 8, 7, 9, 0)
    expect(logPath(root, "docs", "Noah Jang", at)).toBe(path.join(root, "docs", "noah_jang", "2026-09-07.md"))

    const legacy = path.join(root, "docs", "Noah Jang", "2026-09-07.md")
    appendRow(legacy, { at, summary: "legacy", files: [], durationMs: -1, author: "Noah Jang" })
    expect(recentLogFiles(root, "docs", "Noah Jang", 1, at)).toEqual([legacy])
  })
})

describe("extractMessage", () => {
  it("pulls the message out of a CLI's surrounding chatter", () => {
    expect(
      extractMessage(
        [
          "[2026-09-07] session abc123",
          "thinking…",
          OPEN_MARK,
          "feat(log): add status column",
          "",
          "body line",
          CLOSE_MARK,
          "tokens used: 812",
        ].join("\n"),
      ),
    ).toBe("feat(log): add status column\n\nbody line")
  })

  it("falls back to the whole output when the model skipped the marker", () => {
    expect(extractMessage("```\nfix(api): handle null\n```\n")).toBe("fix(api): handle null")
  })
})
