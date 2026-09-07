/**
 * `dokomade log "<제목>"` - add a row by hand.
 *
 * Title only. Naming the files too would mean a path list on the command line
 * for work the tool did not watch happen, which is more typing than the row is
 * worth - `commit` picks those files up as orphans anyway. The 파일 cell renders
 * as `-`, which is the honest answer: nobody recorded them.
 */
import { authorName } from "../core/git.js";
import { appendRow, logPath } from "../core/markdown.js";
import { findRoot, paths, readConfig } from "../core/store.js";

export function log(title: string, cwd: string = process.cwd()): void {
  const clean = title.replace(/\r?\n/g, " ").trim();
  if (!clean) {
    console.error("log: empty title");
    process.exitCode = 1;
    return;
  }

  const root = findRoot(cwd);
  if (!root) {
    console.error("log: dokomade is not initialised here");
    process.exitCode = 1;
    return;
  }

  const at = new Date();
  const author = authorName(root);
  const file = logPath(root, readConfig(paths(root)).logDir, author, at);
  appendRow(file, { at, summary: clean, files: [], durationMs: -1, author, status: "stage" });
  console.log(`logged: ${clean}`);
}
