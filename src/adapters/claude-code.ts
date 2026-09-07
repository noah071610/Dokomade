/**
 * Claude Code hook payloads -> normalized events.
 *
 * Hand-rolled parsing, no zod: this runs inside on-tool, which spawns a fresh
 * Node process on every file edit. Unknown fields are ignored rather than
 * rejected, so a Claude Code release that adds fields cannot break logging.
 *
 * Verified against https://code.claude.com/docs/en/hooks (2026-09).
 */
import type { Adapter, DokomadeEvent } from "./types.js";

/** Tools whose success means a file on disk changed. */
export const FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function filePathsOf(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput as Json;
  const out: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = str(input[key]);
    if (v) out.push(v);
  }
  // MultiEdit-style payloads carry a per-edit path in some versions.
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") {
        const v = str((edit as Json).file_path);
        if (v) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

export const claudeCode: Adapter = {
  name: "claude-code",
  parse(raw: unknown): DokomadeEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Json;
    const sessionId = str(p.session_id) ?? "";
    const cwd = str(p.cwd) ?? process.cwd();

    switch (p.hook_event_name) {
      case "UserPromptSubmit":
        return {
          kind: "prompt",
          sessionId,
          cwd,
          promptText: str(p.prompt) ?? "",
          transcriptPath: str(p.transcript_path),
        };

      case "PostToolUse": {
        const toolName = str(p.tool_name) ?? "";
        if (!FILE_TOOLS.has(toolName)) return null;
        return {
          kind: "tool",
          sessionId,
          cwd,
          toolName,
          filePaths: filePathsOf(p.tool_input),
        };
      }

      case "Stop":
        return {
          kind: "stop",
          sessionId,
          cwd,
          transcriptPath: str(p.transcript_path),
          lastAssistantMessage: str(p.last_assistant_message),
        };

      default:
        return null;
    }
  },
};
