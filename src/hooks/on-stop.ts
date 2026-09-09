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
import { codex } from "../adapters/codex.js";
import { cursor } from "../adapters/cursor.js";
import { findRoot, shouldSkip } from "../core/store.js";
import { claudeCode } from "../adapters/claude-code.js";
import { readPayload } from "./io.js";
import { recordTurn } from "./record-turn.js";

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
  const codexEvent = cursorEvent ? null : codex.parse(raw);
  const event = cursorEvent ?? codexEvent ?? claudeCode.parse(raw);
  if (cursorEvent) cursorReply = "{}";
  if (event?.kind !== "stop") return;

  // Which adapter recognised the payload is the only honest answer to "which
  // agent wrote this row": the tools do not identify themselves in the body.
  const agent = cursorEvent ? "cursor" : codexEvent ? "codex" : "claude";

  const root = findRoot(event.cwd);
  if (!root) return;
  await recordTurn(root, agent, event.lastAssistantMessage, "on-stop", startedAt);
}

run()
  .catch(() => {
    // Never prevent the turn from ending.
  })
  .finally(() => {
    if (cursorReply) process.stdout.write(cursorReply);
    process.exit(0);
  });

// [dokomade] 누락 턴 회수 연결
