/** git plumbing: per-file line deltas and the author name. Builtins only. */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LineDelta {
  added: number;
  removed: number;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function isRepo(root: string): boolean {
  return git(root, ["rev-parse", "--git-dir"]) !== null;
}

/** 경로를 포함하는 저장소를 반환하며, Git 밖이면 null을 반환한다. */
export function repoTopLevel(root: string): string | null {
  return git(root, ["rev-parse", "--show-toplevel"])?.trim() || null;
}

/** 스테이징 전 저장소에서 변경된 파일을 반환한다. */
export function changedFiles(root: string): string[] {
  return (git(root, ["status", "--porcelain", "--untracked-files=all"]) ?? "")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * A revision resolved to its commit sha, or null when git cannot resolve it -
 * an unfetched sha, the all-zero sha a first push reports, or a bare "".
 */
export function resolveRev(root: string, rev: string): string | null {
  if (!rev.trim()) return null;
  const sha = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim();
  return sha ? sha : null;
}

function countLines(file: string): number {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length === 0) return 0;
    return raw.endsWith("\n") ? raw.split("\n").length - 1 : raw.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Added/removed lines per path, relative to HEAD so staged and unstaged edits
 * both count. Untracked files are invisible to `git diff`, so they are counted
 * off disk as +N/-0. Paths that git knows nothing about (no repo at all) get
 * the same treatment.
 */
export function lineDeltas(root: string, relPaths: string[]): Map<string, LineDelta> {
  const out = new Map<string, LineDelta>();
  if (relPaths.length === 0) return out;

  if (isRepo(root)) {
    // `HEAD` fails on a repo with no commits; fall back to the index diff.
    const hasHead = git(root, ["rev-parse", "--verify", "HEAD"]) !== null;
    const raw = git(root, [
      "diff",
      ...(hasHead ? ["HEAD"] : []),
      "--numstat",
      "--no-renames",
      "--",
      ...relPaths,
    ]);
    for (const line of (raw ?? "").split("\n")) {
      if (!line.trim()) continue;
      const [add, del, file] = line.split("\t");
      if (!file) continue;
      // Binary files report "-" for both counts.
      out.set(file, { added: Number(add) || 0, removed: Number(del) || 0 });
    }
  }

  for (const rel of relPaths) {
    if (out.has(rel)) continue;
    const abs = path.join(root, rel);
    out.set(rel, fs.existsSync(abs) ? { added: countLines(abs), removed: 0 } : { added: 0, removed: 0 });
  }
  return out;
}

/**
 * Repo-relative paths whose file changed on disk during this turn.
 *
 * PostToolUse only fires for Edit/Write/MultiEdit/NotebookEdit. A turn that
 * rewrote a file with a Bash heredoc (`cat > tsconfig.json <<'EOF'`), a
 * codemod, or a generator leaves pending.jsonl empty and used to produce no row
 * at all - which is the single most common way a real turn goes unlogged, since
 * several agent presets edit through Bash by default.
 *
 * `git status` is what makes this cheap and safe rather than a working-tree
 * walk: it already honours .gitignore, so node_modules/, dist/, and build
 * output never reach the mtime check. The window is the turn itself, so the
 * scan cannot widen into "every file that was ever dirty".
 *
 * ponytail: mtime-based, so a file the turn deleted is invisible - it has no
 * mtime left to compare. Add a `git status` D-status branch if deletions ever
 * need their own row.
 */
export function changedSince(root: string, sinceMs: number): string[] {
  if (!Number.isFinite(sinceMs)) return [];
  if (!isRepo(root)) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .flatMap((entry) => {
        const child = path.join(root, entry.name)
        if (!isRepo(child)) return []
        return changedSince(child, sinceMs).map((file) => path.join(entry.name, file).split(path.sep).join("/"))
      })
  }
  const raw = git(root, [
    "status",
    "--porcelain",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  if (raw === null) return [];

  const out: string[] = [];
  for (const record of raw.split("\0")) {
    // Each record is "XY <path>": two status columns and a space.
    const rel = record.slice(3);
    if (!rel) continue;
    try {
      if (fs.statSync(path.join(root, rel)).mtimeMs >= sinceMs) out.push(rel);
    } catch {
      // Deleted, or unreadable. Either way there is nothing to log.
    }
  }
  return out;
}

/**
 * Author name. `gh api user` is deliberately not consulted: it is a network
 * round trip inside the Stop hook's latency budget.
 */
export function authorName(root: string): string {
  const configured = git(root, ["config", "user.name"])?.trim();
  if (configured) return configured;
  if (process.env.GIT_AUTHOR_NAME) return process.env.GIT_AUTHOR_NAME;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * Run git, replay its stdout/stderr to the terminal, and retain the output so
 * a failed command can be explained instead of ending at a generic message.
 *
 * The read-only helpers above swallow stderr on purpose - a failed
 * `git config user.name` is not news. A failed `git push` is: the reject
 * message ("non-fast-forward", "no upstream branch") is the whole answer, and
 * hiding it would leave the user with a bare "push failed".
 */
export interface GitResult {
  ok: boolean;
  output: string;
}

export function gitPassthrough(root: string, args: string[], stdin?: string): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    input: stdin,
    encoding: "utf8",
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const processError = result.error?.message ?? (result.signal ? `git 종료됨 (${result.signal})` : undefined);
  const output = [result.stdout, result.stderr, processError]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (processError && !result.stderr) process.stderr.write(`${processError}\n`);
  return { ok: result.status === 0, output };
}

/** Repo-relative paths currently in the index, as `git commit` would take them. */
export function stagedFiles(root: string): string[] {
  const raw = git(root, ["diff", "--cached", "--name-only", "-z"]);
  if (raw === null) return [];
  return raw.split("\0").filter((p) => p.length > 0);
}

/** True when the index holds nothing to commit. */
export function indexIsEmpty(root: string): boolean {
  return stagedFiles(root).length === 0;
}

/**
 * The staged diff for a subset of files, hard-capped at `maxLines`.
 *
 * The cap is the whole point. This text is about to be sent to a model paid
 * for by the user's own token budget, and one regenerated lockfile is tens of
 * thousands of lines - enough to cost more than every other commit that week
 * combined. Truncation is announced in the output so the model knows it is
 * reading a fragment.
 */
export function stagedDiff(root: string, relPaths: string[], maxLines: number): string {
  if (relPaths.length === 0) return "";
  const raw = git(root, ["diff", "--cached", "--unified=1", "--", ...relPaths]);
  if (!raw) return "";
  const lines = raw.split("\n");
  if (lines.length <= maxLines) return raw;
  return `${lines.slice(0, maxLines).join("\n")}\n… (diff truncated at ${maxLines} lines)`;
}

/** Current branch name, or null on a detached HEAD or a repo with no commits. */
export function currentBranch(root: string): string | null {
  const name = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  return name && name !== "HEAD" ? name : null;
}

/** True when the branch has an upstream, so a bare `git push` knows where to go. */
export function hasUpstream(root: string): boolean {
  return git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) !== null;
}
