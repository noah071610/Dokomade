import { describe, expect, it } from "vitest";
import { codex } from "./codex.js";

describe("codex adapter", () => {
  it("normalizes prompt and stop events", () => {
    expect(
      codex.parse({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/repo",
        prompt: "다크모드 추가해줘",
      }),
    ).toMatchObject({ kind: "prompt", sessionId: "session-1", promptText: "다크모드 추가해줘" });

    expect(
      codex.parse({
        hook_event_name: "Stop",
        turn_id: "turn-1",
        last_assistant_message: "완료했습니다.",
      }),
    ).toMatchObject({ kind: "stop", lastAssistantMessage: "완료했습니다." });
  });

  it("extracts paths from an apply_patch tool event", () => {
    expect(
      codex.parse({
        hook_event_name: "PostToolUse",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: src/app/page.tsx\n@@\n*** Add File: src/app/theme.css\n@@\n*** End Patch",
        },
      }),
    ).toMatchObject({ kind: "tool", filePaths: ["src/app/page.tsx", "src/app/theme.css"] });
  });

  it("does not claim Claude payloads", () => {
    expect(codex.parse({ hook_event_name: "Stop", session_id: "claude-session" })).toBeNull();
  });
});
