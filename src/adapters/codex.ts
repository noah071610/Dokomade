/** Codex CLI hook payloads -> normalized events. */
import type { Adapter, DokomadeEvent } from "./types.js";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function filePathsOf(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const command = str((raw as Json).command);
  if (!command) return [];

  const paths = [
    ...command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm),
    ...command.matchAll(/^\*\*\* Move to: (.+)$/gm),
  ].map((match) => match[1]?.trim()) as string[];
  return [...new Set(paths.filter(Boolean))];
}

export const codex: Adapter = {
  name: "codex",
  parse(raw: unknown): DokomadeEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Json;
    // `turn_id` is Codex-specific and keeps same-named Claude events separate.
    if (!str(p.turn_id)) return null;

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
        if (toolName !== "apply_patch") return null;
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
