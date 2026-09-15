/**
 * The user's own AI CLI, used as a fallback commit-message writer.
 *
 * dokomade never holds an API key and never talks to a model provider. Both
 * paths spend the developer's own tokens:
 *
 * `dokomade commit` from a terminal shells out to whichever CLI the user
 * already has logged in.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKIP_ENV, type AiCliId } from "./store.js";

interface CliSpec {
  id: Exclude<AiCliId, "none">;
  bin: string;
  /** Prompt on stdin where the CLI accepts it: no argv length ceiling, no quoting. */
  args: string[];
  stdin: boolean;
  argvPrompt?: (prompt: string) => string[];
}

// The brief embeds text the repository controls - the convention file, file
// names, git error output. A model given tools and a prompt built out of
// untrusted strings can be talked into using them. It only needs to emit text
// here, so every CLI runs with no tools or read-only.
const CLIS: CliSpec[] = [
  // `--allowedTools ""` only skips permission prompts; `--tools ""` removes the tools.
  { id: "claude", bin: "claude", args: ["-p", "--tools", ""], stdin: true },
  // Pinned so a user config with workspace-write or full access does not apply.
  { id: "codex", bin: "codex", args: ["exec", "-s", "read-only", "-"], stdin: true },
  // An untrusted folder makes gemini refuse headless runs: a null answer, not a hole.
  { id: "gemini", bin: "gemini", args: [], stdin: false, argvPrompt: (p) => ["--approval-mode", "plan", "-p", p] },
  // ponytail: cursor-agent is left out - its `-p` has write and bash with no flag
  // to remove them. Add it back once it has a no-tools mode.
];

/** `which`, without spawning a process for it. */
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function availableClis(): Exclude<AiCliId, "none">[] {
  return CLIS.filter((c) => onPath(c.bin)).map((c) => c.id);
}

/**
 * Fences the message off from everything else the CLI prints.
 *
 * `codex exec` frames its answer with session metadata, and cursor-agent can
 * fall back to a JSON stream. Asking for an explicit marker is more reliable
 * than trying to strip each tool's chrome.
 */
export const OPEN_MARK = "<<<DOKOMADE_COMMIT";
export const CLOSE_MARK = "DOKOMADE_COMMIT>>>";

/** Pull the marked message out of a CLI's output, tolerating a missing marker. */
export function extractMessage(raw: string): string {
  const start = raw.indexOf(OPEN_MARK);
  const end = raw.lastIndexOf(CLOSE_MARK);
  const body =
    start !== -1 && end > start ? raw.slice(start + OPEN_MARK.length, end) : raw;
  return body
    .replace(/^\s*```[a-z]*\n?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Run the CLI and return the commit message, or null if it produced nothing.
 *
 * Failure is never fatal: the caller falls back to asking for `-m`. Spending
 * the user's tokens and getting garbage should cost them a retry, not a
 * mangled commit.
 */
export function runAi(id: AiCliId, prompt: string, cwd: string): Promise<string | null> {
  if (id === "none") return Promise.resolve(null);
  const spec = CLIS.find((c) => c.id === id);
  if (!spec || !onPath(spec.bin)) return Promise.resolve(null);

  const args = spec.stdin ? spec.args : (spec.argvPrompt as (p: string) => string[])(prompt);
  return new Promise((resolve) => {
    const child = execFile(
      spec.bin,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, [SKIP_ENV]: "1" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          const message = extractMessage(stdout);
          resolve(message.length > 0 ? message : null);
          return;
        }
        // Without this the caller can only say "no answer": a timeout, a logged-out
        // CLI and a usage limit all look identical from here.
        const e = error as { signal?: string | null };
        const tail = String(stderr ?? "").trim().split("\n").slice(-3).join("\n");
        if (e.signal) console.error(`${spec.bin} 종료됨 (${e.signal}, 180초 제한).`);
        if (tail) console.error(tail);
        resolve(null);
      },
    );
    child.stdin?.end(spec.stdin ? prompt : undefined);
  });
}
