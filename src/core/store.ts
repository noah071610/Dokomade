/**
 * .dokomade/ read & write. Node builtins only.
 *
 * Imported by every hook entry, including the very hot on-tool path, so this
 * file must never grow a third-party import.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { repoTopLevel } from "./git.js"

export const STATE_DIR = ".dokomade"

/**
 * Set on a child process so dokomade's own hooks no-op inside it.
 *
 * Without this, a `dokomade commit` that shells out to the user's AI CLI fires
 * the Stop hook inside that child, and generating a commit message files
 * itself a log row - which then shows up as an uncommitted change in the very
 * commit it was generating for.
 *
 * It lives here rather than next to the CLI launcher because every hook has to
 * check it, and on-tool runs on every file edit: it must not pull in a module
 * it otherwise has no use for.
 */
export const SKIP_ENV = "DOKOMADE_SKIP"

/**
 * Headless runs of the same CLIs, which are never the user's work session.
 *
 * `claude -p` sets CLAUDE_CODE_ENTRYPOINT=sdk-cli. Its prompt is a throwaway
 * string - a commit-message brief, a script, a CI step - and the working tree
 * it sees belongs to whoever spawned it, so a row from there gets a nonsense
 * title over somebody else's files. Only set when nothing set it already: a
 * `claude -p` spawned from inside another session inherits that parent's
 * entrypoint and is not caught here.
 */
const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli"])

export function shouldSkip(): boolean {
  if (process.env[SKIP_ENV] === "1") return true
  return HEADLESS_ENTRYPOINTS.has(process.env.CLAUDE_CODE_ENTRYPOINT ?? "")
}

export interface Paths {
  root: string
  dir: string
  config: string
  state: string
  pending: string
  queue: string
  perf: string
}

export interface WorkspaceRepository {
  name: string
  root: string
  relative: string
}

/** 초기화된 workspace가 Git이 아닐 때 바로 아래 저장소를 찾는다. */
export function workspaceRepositories(root: string): WorkspaceRepository[] {
  const workspace = fs.realpathSync(path.resolve(root))
  const own = repoTopLevel(workspace)
  if (own) return [{ name: path.basename(own), root: own, relative: "." }]

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true })
  } catch {
    return []
  }

  const seen = new Set<string>()
  const repos = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => {
      const repo = repoTopLevel(path.join(workspace, entry.name))
      return repo ? fs.realpathSync(repo) : null
    })
    .filter((repo): repo is string => typeof repo === "string")
    .filter((repo) => path.dirname(repo) === workspace)
    .filter((repo) => !seen.has(repo) && seen.add(repo))
  return repos.map((repo) => ({ name: path.basename(repo), root: repo, relative: path.relative(workspace, repo) || "." }))
}

export interface State {
  promptStartedAt?: number
  lastPromptText?: string
  sessionId?: string
  agent?: "claude" | "codex" | "cursor"
  transcriptOffset?: number
}

export interface PendingEntry {
  ts: number
  tool: string
  path: string
}

/**
 * One logged row, in machine-readable form: the ledger `commit` reads.
 *
 * The markdown row cannot serve this purpose. It renders the file cell as a
 * bare basename, so `src/core/git.ts` and `test/git.ts` collapse into the same
 * `git.ts` - comparing that against `git diff --cached --name-only` produces
 * false matches and silently hides real gaps. The markdown is for people; this
 * is for the diff comparison.
 *
 * Holds `stage` rows only. Cleared once they are committed - a committed row's
 * paths are never needed again, and push does not care which files moved.
 */
export interface QueueEntry {
  /** Log file date, `YYYY-MM-DD`. */
  date: string
  /** Row time, `HH:MM`. Together with `date` this addresses the markdown row. */
  time: string
  /** Repo-relative paths, full - not basenames. */
  files: string[]
}

export interface ClassifyConfig {
  frontend: { pageDirs: string[]; sharedDirs: string[] }
  backend: { routeDirs: string[] }
}

export type ProjectType = "frontend" | "backend" | "fullstack" | "library"

/**
 * Which of the user's own AI CLIs `dokomade commit` may shell out to when it
 * is run from a bare terminal, with no assistant in the loop to write the
 * message itself. "none" disables the fallback: the command then prints the
 * brief and asks for `-am`.
 */
export type AiCliId = "claude" | "codex" | "cursor" | "gemini" | "none"

export interface CommitConfig {
  /** Days of log files `commit` scans for `stage` rows. */
  windowDays: number
  /** Path to the Conventional Commits reference, relative to the repo root. */
  convention: string
  /** CLI used for the terminal fallback. */
  ai: AiCliId
  /** Whether the user has chosen the terminal fallback yet. */
  aiConfigured: boolean
  /**
   * Spend tokens describing files that changed without a log row. Off by
   * default: after the noise filter, what is left is usually nothing, and a
   * row reading "수동 수정 (3 files)" costs zero and says nearly as much.
   */
  analyzeOrphans: boolean
}

export interface Config {
  logDir: string
  projectType: ProjectType
  classify: ClassifyConfig
  commit: CommitConfig
  integrations: { notion: boolean; sheets: boolean }
}

export const DEFAULT_COMMIT: CommitConfig = {
  windowDays: 7,
  convention: "commit-convention.md",
  ai: "none",
  aiConfigured: false,
  analyzeOrphans: false,
}

export const DEFAULT_CONFIG: Config = {
  logDir: "docs/dokomade",
  projectType: "fullstack",
  classify: {
    frontend: {
      pageDirs: ["src/app", "src/pages", "app", "pages"],
      sharedDirs: ["src/components", "src/shared", "components"],
    },
    backend: {
      routeDirs: ["src/api", "src/controllers", "src/routes", "api"],
    },
  },
  commit: DEFAULT_COMMIT,
  integrations: { notion: false, sheets: false },
}

export function paths(root: string): Paths {
  const dir = path.join(root, STATE_DIR)
  return {
    root,
    dir,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    pending: path.join(dir, "pending.jsonl"),
    queue: path.join(dir, "queue.jsonl"),
    perf: path.join(dir, "perf.jsonl"),
  }
}

/** Keep config paths relative to the project; config is repository-controlled input. */
export function safeRelativePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const candidate = value.trim()
  const normalized = candidate.replaceAll("\\", "/")
  if (
    !candidate ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return fallback
  }
  return candidate
}

/** Return a canonical project-relative path, or null for paths outside it. */
export function repoRelativePath(root: string, target: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null
  }
  return relative.split(path.sep).join("/")
}

/**
 * Outermost ancestor of `from` holding a `.dokomade/` directory, else null.
 *
 * Outermost, not nearest: an init left behind in a subfolder (a frontend set
 * up on its own, later wrapped in a top-level package that was set up too)
 * would otherwise split one session's logs by whichever folder the agent last
 * `cd`-ed into. The top-level init wins, even when the subfolder kept its own
 * `.git`.
 *
 * A parent workspace init always wins, including over child repository
 * installs. The walk never leaves the home directory, and a repo that was
 * never initialised is never captured.
 */
export function findRoot(from: string): string | null {
  const home = os.homedir()
  let cur = path.resolve(from)
  let found: string | null = null
  for (;;) {
    if (
      // Home never overrides a project below it.
      !(found && cur === home) &&
      fs.existsSync(path.join(cur, STATE_DIR))
    ) {
      found = cur
    }
    const parent = path.dirname(cur)
    if (parent === cur || cur === home) return found
    cur = parent
  }
}

/** Same walk, but falls back to the git root / cwd. Used by `init`. */
export function guessRoot(from: string): string {
  let cur = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(cur, STATE_DIR))) return cur
    if (fs.existsSync(path.join(cur, ".git"))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(from)
    cur = parent
  }
}

/**
 * Where `init` puts the logs: next to the one package.json that installs
 * dokomade, so a lone `apps/web` install logs under `apps/web/docs/dokomade`.
 *
 * Anything ambiguous - installs in two packages, an install at the root, or a
 * leftover `.dokomade/` from an init in a subfolder - gets the top-level
 * `docs/dokomade`, so a double init never splits the logs.
 */
export function defaultLogDir(root: string): string {
  const installs: string[] = []
  let nestedInit = false
  const lists = (deps: unknown): boolean => typeof deps === "object" && deps !== null && "dokomade" in deps
  // ponytail: depth 4 covers apps/web and packages/@scope/pkg; deeper installs get the top-level default
  const walk = (dir: string, depth: number): void => {
    if (dir !== root && fs.existsSync(path.join(dir, STATE_DIR))) nestedInit = true
    const pkg = readJSON<Record<string, unknown> | null>(path.join(dir, "package.json"), null)
    if (pkg && (lists(pkg.dependencies) || lists(pkg.devDependencies))) installs.push(dir)
    if (depth === 0) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        walk(path.join(dir, entry.name), depth - 1)
      }
    }
  }
  walk(root, 4)

  const only = installs.length === 1 && !nestedInit ? installs[0] : undefined
  if (!only || only === root) return DEFAULT_CONFIG.logDir
  return `${path.relative(root, only).split(path.sep).join("/")}/${DEFAULT_CONFIG.logDir}`
}

export function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

/**
 * Drop `//` line comments that sit outside a string.
 *
 * Only config.json is read this way: it ships annotations so the file explains
 * itself without a second document. Scanning for the quote state rather than
 * regex-replacing matters - `"logDir": "https://x"` and a Windows UNC path both
 * contain `//` inside a value, and a naive strip would eat the rest of the line.
 */
function stripLineComments(src: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
      continue
    }
    out += ch
  }
  return out
}

export function readJSONC<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(stripLineComments(fs.readFileSync(file, "utf8"))) as T
  } catch {
    return fallback
  }
}

/** Write via tmp + rename so a crashed hook never leaves a half-written file. */
export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function writeJSON(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Append one JSONL record. `appendFileSync` opens with O_APPEND, so concurrent
 * hook processes interleave whole lines rather than corrupting each other.
 */
export function appendJSONL(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export function readJSONL<T>(file: string): T[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // A torn line from a killed process. Drop it, keep the rest.
    }
  }
  return out
}

/**
 * Atomically claim the pending log: rename it aside, then read the claimed
 * copy. A tool hook that fires mid-Stop writes to a fresh pending.jsonl
 * instead of into a file we are about to delete.
 */
export function claimPending(p: Paths): { entries: PendingEntry[]; claimed: string | null } {
  const claimed = `${p.pending}.${Date.now()}.${process.pid}.claim`
  try {
    fs.renameSync(p.pending, claimed)
  } catch {
    return { entries: [], claimed: null }
  }
  return { entries: readJSONL<PendingEntry>(claimed), claimed }
}

export function readState(p: Paths): State {
  return readJSON<State>(p.state, {})
}

export function readConfig(p: Paths): Config {
  const raw = readJSONC<Partial<Config>>(p.config, {})
  const aiConfigured =
    typeof raw.commit?.aiConfigured === "boolean" ? raw.commit.aiConfigured : raw.commit?.ai !== undefined
  return {
    logDir: safeRelativePath(raw.logDir, DEFAULT_CONFIG.logDir),
    projectType:
      raw.projectType === "frontend" ||
      raw.projectType === "backend" ||
      raw.projectType === "fullstack" ||
      raw.projectType === "library"
        ? raw.projectType
        : DEFAULT_CONFIG.projectType,
    classify: {
      frontend: { ...DEFAULT_CONFIG.classify.frontend, ...raw.classify?.frontend },
      backend: { ...DEFAULT_CONFIG.classify.backend, ...raw.classify?.backend },
    },
    commit: {
      ...DEFAULT_COMMIT,
      ...raw.commit,
      convention: safeRelativePath(raw.commit?.convention, DEFAULT_COMMIT.convention),
      aiConfigured,
      // A window of 0 would make `commit` find nothing and report "no staged
      // rows" on a repo full of them.
      windowDays: Math.max(1, Number(raw.commit?.windowDays) || DEFAULT_COMMIT.windowDays),
    },
    integrations: {
      ...DEFAULT_CONFIG.integrations,
      notion: raw.integrations?.notion === true,
      sheets: raw.integrations?.sheets === true,
    },
  }
}

export function writeConfig(p: Paths, config: Config): void {
  writeJSON(p.config, config)
}

/** Hook wall time, for the §13 "measure before choosing a launcher" decision. */
export function recordPerf(p: Paths, hook: string, startedAt: number): void {
  try {
    appendJSONL(p.perf, { ts: Date.now(), hook, ms: Date.now() - startedAt })
  } catch {
    // Perf logging must never break a hook.
  }
}
