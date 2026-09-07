/** `dokomade status` - what is queued, and how slow the hooks actually are. */
import fs from "node:fs";
import path from "node:path";
import { authorName } from "../core/git.js";
import { dateKey, logPath, recentLogFiles, rowsWithStatus } from "../core/markdown.js";
import {
  findRoot,
  paths,
  readConfig,
  readJSONL,
  readState,
  type PendingEntry,
} from "../core/store.js";

interface PerfEntry {
  hook: string;
  ms: number;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? 0;
}

export function status(cwd: string = process.cwd()): void {
  const root = findRoot(cwd);
  if (!root) {
    console.log("dokomade is not initialised here. Run `dokomade init`.");
    process.exitCode = 1;
    return;
  }

  const p = paths(root);
  const config = readConfig(p);
  const state = readState(p);
  const pending = readJSONL<PendingEntry>(p.pending);
  const author = authorName(root);
  const today = logPath(root, config.logDir, author, new Date());

  console.log(`root      ${root}`);
  console.log(`author    ${author}`);
  console.log(
    `prompt    ${state.promptStartedAt ? new Date(state.promptStartedAt).toLocaleString() : "-"}`,
  );
  if (state.lastPromptText) console.log(`          "${state.lastPromptText.split("\n")[0]}"`);

  console.log(`pending   ${pending.length} tool call(s) this turn`);
  for (const rel of [...new Set(pending.map((e) => e.path))].slice(0, 10)) {
    console.log(`          ${rel}`);
  }

  const rows = fs.existsSync(today)
    ? fs.readFileSync(today, "utf8").split("\n").filter((l) => /^\|\s*\d{2}:\d{2}\s*\|/.test(l)).length
    : 0;
  console.log(`log       ${path.relative(root, today)} (${rows} row(s), ${dateKey(new Date())})`);

  // What `dokomade commit` would pick up: the whole window, not just today.
  const window = recentLogFiles(root, config.logDir, author, config.commit.windowDays);
  const staged = rowsWithStatus(window, "stage");
  console.log(
    `commit    ${staged.length} row(s) in stage across ${window.length} day(s), ai=${config.commit.ai}`,
  );
  for (const row of staged.slice(0, 10)) console.log(`          ${row.time} ${row.summary}`);

  // The §13 launcher decision is meant to be made off these numbers, not a guess.
  const perf = readJSONL<PerfEntry>(p.perf);
  if (perf.length > 0) {
    console.log("hook time (ms)");
    for (const hook of ["on-prompt", "on-tool", "on-stop"]) {
      const samples = perf.filter((e) => e.hook === hook).map((e) => e.ms).sort((a, b) => a - b);
      if (samples.length === 0) continue;
      console.log(
        `          ${hook.padEnd(10)} n=${String(samples.length).padEnd(5)} p50=${percentile(
          samples,
          0.5,
        )} p95=${percentile(samples, 0.95)} max=${samples[samples.length - 1]}`,
      );
    }
  }
}
