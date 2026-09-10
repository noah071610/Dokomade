#!/usr/bin/env node
/**
 * PostToolUse / afterFileEdit: record which file the AI actually touched.
 *
 * The hottest code in the project - a fresh Node process per file edit. It
 * does one stdin read, one existsSync walk, and one appendFileSync. Keep it
 * that way; anything heavier is felt as lag.
 *
 * Why record this at all when Stop could just run `git diff`: a diff cannot
 * tell the AI's edits from the user's, cannot see a file created and deleted
 * within the turn, and does not exist outside a git repo.
 */
import path from "node:path";
import { codex } from "../adapters/codex.js";
import { claudeCode } from "../adapters/claude-code.js";
import { cursor } from "../adapters/cursor.js";
import { appendJSONL, findRoot, paths, recordPerf, repoRelativePath, shouldSkip } from "../core/store.js";
import { readPayload } from "./io.js";

const startedAt = Date.now();

// A `dokomade commit` that shelled out to the user's own CLI is running us
// inside itself. Logging that would file a row for writing a commit message.
if (shouldSkip()) process.exit(0);

/** Cursor reads stdout as JSON; afterFileEdit has no required fields. */
let cursorReply: string | null = null;

try {
  const raw = readPayload();
  const cursorEvent = cursor.parse(raw);
  const event = cursorEvent ?? codex.parse(raw) ?? claudeCode.parse(raw);
  if (cursorEvent) cursorReply = "{}";
  if (event?.kind === "tool" && event.filePaths.length > 0) {
    const root = findRoot(event.cwd);
    if (root) {
      const p = paths(root);
      for (const filePath of event.filePaths) {
        const abs = path.resolve(event.cwd, filePath);
        const relative = repoRelativePath(root, abs);
        if (!relative) continue;
        // Store repo-relative so the log stays portable across machines.
        appendJSONL(p.pending, {
          ts: startedAt,
          tool: event.toolName,
          path: relative,
        });
      }
      recordPerf(p, "on-tool", startedAt);
    }
  }
} catch {
  // A dropped record is better than a visible error mid-edit.
}

if (cursorReply) process.stdout.write(cursorReply);

process.exit(0);
