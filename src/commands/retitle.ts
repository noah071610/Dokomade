/**
 * `dokomade retitle "<title>"` - replace the 작업 cell of the row just written.
 *
 * The Stop command hook and the Stop agent hook run in parallel, so the row is
 * already on disk by the time the agent has a title. Rather than making the
 * row wait on a model call that may never answer, the row lands immediately
 * with the mechanical title and the agent upgrades it in place.
 *
 * This is the one place dokomade edits a row it already wrote. It is bounded:
 * only the last row, only within `MAX_AGE_MS`, only the title cell.
 */
import fs from "node:fs";
import { authorName } from "../core/git.js";
import { logPath, timeKey } from "../core/markdown.js";
import { findRoot, paths, readConfig } from "../core/store.js";

/** A stale agent must not relabel someone else's later work. */
const MAX_AGE_MS = 10 * 60 * 1000;

const ROW = /^\|\s*(\d{2}:\d{2})\s*\|([^|]*)\|/;

export function retitle(title: string, cwd: string = process.cwd()): void {
  const clean = title.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  if (!clean) {
    console.error("retitle: empty title");
    process.exitCode = 1;
    return;
  }

  const root = findRoot(cwd);
  if (!root) {
    console.error("retitle: dokomade is not initialised here");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const file = logPath(root, readConfig(paths(root)).logDir, authorName(root), now);
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    console.error("retitle: no log for today");
    process.exitCode = 1;
    return;
  }

  const index = lines.findLastIndex((l) => ROW.test(l));
  if (index === -1) {
    console.error("retitle: no row to retitle");
    process.exitCode = 1;
    return;
  }

  const row = lines[index] as string;
  const at = (ROW.exec(row) as RegExpExecArray)[1] as string;
  const [h, m] = at.split(":").map(Number) as [number, number];
  const rowTime = new Date(now);
  rowTime.setHours(h, m, 0, 0);
  if (Math.abs(now.getTime() - rowTime.getTime()) > MAX_AGE_MS) {
    console.error(`retitle: last row (${at}) is too old to relabel`);
    process.exitCode = 1;
    return;
  }

  lines[index] = row.replace(ROW, (_m, time: string) => `| ${time} | ${clean} |`);
  fs.writeFileSync(file, lines.join("\n"));
  console.log(`retitled ${at} -> ${clean}`);
}
