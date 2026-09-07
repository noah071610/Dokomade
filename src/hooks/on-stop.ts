#!/usr/bin/env node
/**
 * Stop: turn this turn's pending records into one markdown row.
 *
 * Everything here is a plain script except the summarizer, which is the single
 * place the tool is allowed to spend tokens. A turn that edited twenty files
 * still produces at most one summarizer call.
 *
 * Exit code is always 0. Exit 2 on this event prevents Claude from stopping,
 * which would trap the user in a loop.
 */
import { classifyAll } from "../core/classify.js";
import { codex } from "../adapters/codex.js";
import { cursor } from "../adapters/cursor.js";
import { authorName, changedSince, lineDeltas } from "../core/git.js";
import { appendRow, dateKey, logPath, timeKey, type FileChange } from "../core/markdown.js";
import { MechanicalSummarizer } from "../core/summarize.js";
import {
  STATE_DIR,
  appendJSONL,
  claimPending,
  findRoot,
  paths,
  readConfig,
  readState,
  recordPerf,
  shouldSkip,
  writeJSON,
} from "../core/store.js";
import { claudeCode } from "../adapters/claude-code.js";
import { readPayload } from "./io.js";
import fs from "node:fs";

const startedAt = Date.now();

// Running inside a `dokomade commit` that shelled out to the user's own CLI.
if (shouldSkip()) process.exit(0);

/**
 * Cursor reads stdout as JSON. An empty object is the "no follow-up message"
 * answer; anything else would auto-submit a new turn.
 */
let cursorReply: string | null = null;

async function run(): Promise<void> {
  const raw = readPayload();
  const cursorEvent = cursor.parse(raw);
  const event = cursorEvent ?? codex.parse(raw) ?? claudeCode.parse(raw);
  if (cursorEvent) cursorReply = "{}";
  if (event?.kind !== "stop") return;

  const root = findRoot(event.cwd);
  if (!root) return;
  const p = paths(root);

  // A turn that only answered a question leaves nothing changed, and gets no
  // row. Silence is the correct log entry for "no files changed" - but the
  // perf line still has to be written, or a Stop hook that ran and correctly
  // did nothing is indistinguishable from one that was never registered.
  const { entries, claimed } = claimPending(p);

  try {
    const config = readConfig(p);
    const state = readState(p);

    // Two sources, because neither sees everything: pending.jsonl has what the
    // AI edited through a tracked tool (including a file created and deleted
    // inside the turn, which leaves no trace on disk), and `changedSince` has
    // everything else that moved during the turn - Bash heredocs, generators,
    // installs. Without a start time there is no window to bound the second
    // one, so it is skipped rather than sweeping in the whole working tree.
    //
    // The log directory is excluded for the same reason .dokomade/ is: writing
    // a row, or `commit` flipping a 상태 cell, changes a file inside the turn's
    // window - and `changedSince` would then file a row about dokomade
    // bookkeeping, whose own row would be bookkeeping in turn.
    const logDirPrefix = `${config.logDir.replace(/\/+$/, "")}/`;
    const relPaths = [
      ...new Set(
        [
          ...entries.map((e) => e.path),
          ...(state.promptStartedAt ? changedSince(root, state.promptStartedAt) : []),
        ].filter(
          (rel) => rel && !rel.startsWith(`${STATE_DIR}/`) && !rel.startsWith(logDirPrefix),
        ),
      ),
    ];
    if (relPaths.length === 0) return;

    const deltas = lineDeltas(root, relPaths);
    const files: FileChange[] = relPaths.map((rel) => ({
      path: rel,
      added: deltas.get(rel)?.added ?? 0,
      removed: deltas.get(rel)?.removed ?? 0,
    }));

    const labels = classifyAll(relPaths, config.classify);
    const summary = await new MechanicalSummarizer().summarize({
      promptText: state.lastPromptText ?? "",
      labels,
      files,
      lastAssistantMessage: event.lastAssistantMessage,
    });

    const at = new Date();
    const author = authorName(root);
    appendRow(logPath(root, config.logDir, author, at), {
      at,
      summary,
      files,
      durationMs: state.promptStartedAt ? at.getTime() - state.promptStartedAt : -1,
      author,
      status: "stage",
    });

    // The machine-readable half of the same row. `commit` diffs this against
    // the git index to find files that changed with no row behind them; it
    // cannot use the markdown, whose 파일 cell keeps only the basename.
    appendJSONL(p.queue, {
      date: dateKey(at),
      time: timeKey(at),
      files: relPaths,
    });

    // Consume the prompt. If the next turn's UserPromptSubmit never lands (a
    // malformed payload, a hook that was not registered), the row must fall
    // back to the assistant message rather than silently reusing this title.
    writeJSON(p.state, {
      ...state,
      lastPromptText: undefined,
      promptStartedAt: undefined,
    });
  } finally {
    if (claimed) fs.rmSync(claimed, { force: true });
    recordPerf(p, "on-stop", startedAt);
  }
}

run()
  .catch(() => {
    // Never prevent the turn from ending.
  })
  .finally(() => {
    if (cursorReply) process.stdout.write(cursorReply);
    process.exit(0);
  });
