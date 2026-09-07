#!/usr/bin/env node
/**
 * UserPromptSubmit / beforeSubmitPrompt: stamp the turn's start time, and
 * quietly ask the assistant to title its own work.
 *
 * On Claude Code and Codex the request goes out as
 * `hookSpecificOutput.additionalContext`, which is injected as a system
 * reminder - it never appears in the prompt box or as a chat bubble. The
 * answer comes back through `last_assistant_message` on Stop, so no tool call
 * is needed to collect it either.
 *
 * Cursor has no such channel: `beforeSubmitPrompt` accepts only `continue` and
 * `user_message`, so it gets an explicit allow instead and its rows are titled
 * from the prompt text.
 *
 * Exit code is always 0. Exit 2 on this event erases the user's prompt, so no
 * failure in here may ever escape as a non-zero status. Nothing else may write
 * to stdout: each tool only parses the JSON when it is the whole of it.
 */
import { codex } from "../adapters/codex.js";
import { claudeCode } from "../adapters/claude-code.js";
import { cursor } from "../adapters/cursor.js";
import { TITLE_REQUEST } from "../core/summarize.js";
import { findRoot, paths, readState, recordPerf, shouldSkip, writeJSON } from "../core/store.js";
import { readPayload } from "./io.js";

const startedAt = Date.now();

// A `dokomade commit` that shelled out to the user's own CLI is running us
// inside itself. Logging that would file a row for writing a commit message.
if (shouldSkip()) process.exit(0);

/**
 * Cursor reads stdout as JSON and blocks on `continue: false`. Answering
 * explicitly means no failure below can ever swallow the user's prompt.
 */
let cursorReply: string | null = null;

try {
  const raw = readPayload();
  const cursorEvent = cursor.parse(raw);
  const event = cursorEvent ?? codex.parse(raw) ?? claudeCode.parse(raw);
  if (event?.kind === "prompt") {
    if (cursorEvent) cursorReply = JSON.stringify({ continue: true });
    const root = findRoot(event.cwd);
    if (root) {
      const p = paths(root);
      writeJSON(p.state, {
        ...readState(p),
        promptStartedAt: startedAt,
        lastPromptText: event.promptText,
        sessionId: event.sessionId,
      });
      if (!cursorEvent) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: TITLE_REQUEST,
            },
          }),
        );
      }
      recordPerf(p, "on-prompt", startedAt);
    }
  }
} catch {
  // Never block the user's prompt.
}

if (cursorReply) process.stdout.write(cursorReply);

process.exit(0);
