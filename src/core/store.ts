/**
 * .dokomade/ read & write. Node builtins only.
 *
 * Imported by every hook entry, including the very hot on-tool path, so this
 * file must never grow a third-party import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = ".dokomade";

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
export const SKIP_ENV = "DOKOMADE_SKIP";

export function shouldSkip(): boolean {
  return process.env[SKIP_ENV] === "1";
}


export interface Paths {
  root: string;
  dir: string;
  config: string;
  state: string;
  pending: string;
  queue: string;
  perf: string;
}

export interface State {
  promptStartedAt?: number;
  lastPromptText?: string;
  sessionId?: string;
  transcriptOffset?: number;
}

export interface PendingEntry {
  ts: number;
  tool: string;
  path: string;
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
  date: string;
  /** Row time, `HH:MM`. Together with `date` this addresses the markdown row. */
  time: string;
  /** Repo-relative paths, full - not basenames. */
  files: string[];
}

export interface ClassifyConfig {
  frontend: { pageDirs: string[]; sharedDirs: string[] };
  backend: { routeDirs: string[] };
}

export type ProjectType = "frontend" | "backend" | "fullstack";

/**
 * Which of the user's own AI CLIs `dokomade commit` may shell out to when it
 * is run from a bare terminal, with no assistant in the loop to write the
 * message itself. "none" disables the fallback: the command then prints the
 * brief and asks for `-m`.
 */
export type AiCliId = "claude" | "codex" | "cursor" | "gemini" | "none";

export interface CommitConfig {
  /** Days of log files `commit` scans for `stage` rows. */
  windowDays: number;
  /** Path to the Conventional Commits reference, relative to the repo root. */
  convention: string;
  /** CLI used for the terminal fallback. */
  ai: AiCliId;
  /**
   * Spend tokens describing files that changed without a log row. Off by
   * default: after the noise filter, what is left is usually nothing, and a
   * row reading "수동 수정 (3 files)" costs zero and says nearly as much.
   */
  analyzeOrphans: boolean;
}

export interface Config {
  logDir: string;
  projectType: ProjectType;
  classify: ClassifyConfig;
  commit: CommitConfig;
  integrations: { notion: boolean; slack: boolean; sheets: boolean };
}

export const DEFAULT_COMMIT: CommitConfig = {
  windowDays: 7,
  convention: "commit-convention.md",
  ai: "none",
  analyzeOrphans: false,
};

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
  integrations: { notion: false, slack: false, sheets: false },
};

export function paths(root: string): Paths {
  const dir = path.join(root, STATE_DIR);
  return {
    root,
    dir,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    pending: path.join(dir, "pending.jsonl"),
    queue: path.join(dir, "queue.jsonl"),
    perf: path.join(dir, "perf.jsonl"),
  };
}

/**
 * Nearest ancestor of `from` holding a `.dokomade/` directory, else null.
 *
 * The walk stops at the repository root and never leaves the home directory:
 * a stray `dokomade init` in `~` must not silently capture every project
 * underneath it.
 */
export function findRoot(from: string): string | null {
  const home = os.homedir();
  let cur = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(cur, STATE_DIR))) return cur;
    // A project boundary with no .dokomade/ means dokomade is not set up here.
    if (fs.existsSync(path.join(cur, ".git"))) return null;
    const parent = path.dirname(cur);
    if (parent === cur || cur === home) return null;
    cur = parent;
  }
}

/** Same walk, but falls back to the git root / cwd. Used by `init`. */
export function guessRoot(from: string): string {
  let cur = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(cur, STATE_DIR))) return cur;
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(from);
    cur = parent;
  }
}

export function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via tmp + rename so a crashed hook never leaves a half-written file. */
export function writeJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Append one JSONL record. `appendFileSync` opens with O_APPEND, so concurrent
 * hook processes interleave whole lines rather than corrupting each other.
 */
export function appendJSONL(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJSONL<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line from a killed process. Drop it, keep the rest.
    }
  }
  return out;
}

/**
 * Atomically claim the pending log: rename it aside, then read the claimed
 * copy. A tool hook that fires mid-Stop writes to a fresh pending.jsonl
 * instead of into a file we are about to delete.
 */
export function claimPending(p: Paths): { entries: PendingEntry[]; claimed: string | null } {
  const claimed = `${p.pending}.${Date.now()}.${process.pid}.claim`;
  try {
    fs.renameSync(p.pending, claimed);
  } catch {
    return { entries: [], claimed: null };
  }
  return { entries: readJSONL<PendingEntry>(claimed), claimed };
}

export function readState(p: Paths): State {
  return readJSON<State>(p.state, {});
}

export function readConfig(p: Paths): Config {
  const raw = readJSON<Partial<Config>>(p.config, {});
  return {
    logDir: raw.logDir ?? DEFAULT_CONFIG.logDir,
    projectType:
      raw.projectType === "frontend" || raw.projectType === "backend" || raw.projectType === "fullstack"
        ? raw.projectType
        : DEFAULT_CONFIG.projectType,
    classify: {
      frontend: { ...DEFAULT_CONFIG.classify.frontend, ...raw.classify?.frontend },
      backend: { ...DEFAULT_CONFIG.classify.backend, ...raw.classify?.backend },
    },
    commit: {
      ...DEFAULT_COMMIT,
      ...raw.commit,
      // A window of 0 would make `commit` find nothing and report "no staged
      // rows" on a repo full of them.
      windowDays: Math.max(1, Number(raw.commit?.windowDays) || DEFAULT_COMMIT.windowDays),
    },
    integrations: { ...DEFAULT_CONFIG.integrations, ...raw.integrations },
  };
}

/** Hook wall time, for the §13 "measure before choosing a launcher" decision. */
export function recordPerf(p: Paths, hook: string, startedAt: number): void {
  try {
    appendJSONL(p.perf, { ts: Date.now(), hook, ms: Date.now() - startedAt });
  } catch {
    // Perf logging must never break a hook.
  }
}
