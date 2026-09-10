/**
 * Cursor hook payloads -> normalized events.
 *
 * Cursor names nothing the way Claude Code does: the events are
 * `beforeSubmitPrompt` / `afterFileEdit` / `stop`, the session is
 * `conversation_id`, there is no `cwd` (only `workspace_roots`), and an edit
 * reports `file_path` at the top level instead of inside `tool_input`.
 *
 * Verified against https://cursor.com/docs/agent/hooks (2026-09).
 *
 * Title generation stays per-tool by design. Cursor's `beforeSubmitPrompt`
 * has no context-injection channel (its only output fields are `continue` and
 * `user_message`), so the `[summary]` / `[goal]` / `[scope]` request is never sent here and
 * `stop` carries no assistant message. Rows written from Cursor fall back to
 * the prompt text, which MechanicalSummarizer already handles.
 */
import type { Adapter, DokomadeEvent } from "./types.js";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Cursor gives `workspace_roots`, never `cwd`. Project hooks are spawned from
 * the project root, so `process.cwd()` is the right fallback when the field is
 * absent or empty.
 */
function workspaceRoot(p: Json): string {
  const roots = p.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      const v = str(root);
      if (v) return v;
    }
  }
  return str(process.env.CURSOR_PROJECT_DIR) ?? process.cwd();
}

/**
 * True for a payload Cursor produced. `conversation_id` is in every Cursor
 * hook's common input and in none of Claude Code's or Codex's - without this
 * gate, Cursor's `stop` and Claude Code's `Stop` would collide once the event
 * name is compared case-insensitively.
 */
function isCursorPayload(p: Json): boolean {
  return Boolean(str(p.conversation_id)) || Array.isArray(p.workspace_roots);
}

export const cursor: Adapter = {
  name: "cursor",
  parse(raw: unknown): DokomadeEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Json;
    if (!isCursorPayload(p)) return null;

    const sessionId = str(p.conversation_id) ?? "";
    const cwd = workspaceRoot(p);

    switch (str(p.hook_event_name)?.toLowerCase()) {
      case "beforesubmitprompt":
        return {
          kind: "prompt",
          sessionId,
          cwd,
          promptText: str(p.prompt) ?? "",
          transcriptPath: str(p.transcript_path),
        };

      case "afterfileedit": {
        const filePath = str(p.file_path);
        if (!filePath) return null;
        return {
          kind: "tool",
          sessionId,
          cwd,
          // There is no tool name in the payload; afterFileEdit only ever
          // fires for an edit, so name it after the event.
          toolName: "afterFileEdit",
          filePaths: [filePath],
        };
      }

      case "stop":
        return {
          kind: "stop",
          sessionId,
          cwd,
          transcriptPath: str(p.transcript_path),
          // Cursor's stop payload carries only `status` and `loop_count`.
          lastAssistantMessage: undefined,
        };

      default:
        return null;
    }
  },
};
