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
 * Cursor의 beforeSubmitPrompt는 continue와 user_message만 반환하므로
 * 제목 태그 요청을 주입하지 않는다. stop에도 응답 본문이 없어서
 * MechanicalSummarizer는 변경 파일명으로 제목을 만들고 Goal을 비우며,
 * Scope는 Etc로 기록한다. 프롬프트는 제목에 사용하지 않는다.
 */
import path from "node:path";
import type { Adapter, DokomadeEvent } from "./types.js";

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * 프로젝트 환경변수를 우선하고, 없으면 실제 훅 작업 폴더와 일치하는
 * workspace 루트를 선택한다. 실행 위치가 workspace 밖이면 첫 루트를 쓴다.
 */
function workspaceRoot(p: Json): string {
  const projectDir = str(process.env.CURSOR_PROJECT_DIR);
  if (projectDir) return projectDir;
  const cwd = process.cwd();
  const roots = Array.isArray(p.workspace_roots)
    ? p.workspace_roots.filter((root): root is string => Boolean(str(root)))
    : [];
  return roots.some((root) => path.resolve(root) === cwd) ? cwd : roots[0] ?? cwd;
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
