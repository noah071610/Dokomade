import { describe, expect, it } from "vitest";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";

const common = {
  conversation_id: "conv-1",
  workspace_roots: ["/repo"],
};

describe("cursor adapter", () => {
  it("normalizes beforeSubmitPrompt", () => {
    expect(
      cursor.parse({
        ...common,
        hook_event_name: "beforeSubmitPrompt",
        prompt: "다크모드 추가해줘",
      }),
    ).toMatchObject({
      kind: "prompt",
      sessionId: "conv-1",
      cwd: "/repo",
      promptText: "다크모드 추가해줘",
    });
  });

  it("normalizes afterFileEdit into a tool event", () => {
    expect(
      cursor.parse({
        ...common,
        hook_event_name: "afterFileEdit",
        file_path: "/repo/src/app/page.tsx",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toMatchObject({ kind: "tool", filePaths: ["/repo/src/app/page.tsx"] });
  });

  it("normalizes stop, which carries no assistant message", () => {
    expect(
      cursor.parse({ ...common, hook_event_name: "stop", status: "completed", loop_count: 0 }),
    ).toMatchObject({ kind: "stop", cwd: "/repo", lastAssistantMessage: undefined });
  });

  it("ignores cursor events dokomade does not track", () => {
    expect(cursor.parse({ ...common, hook_event_name: "beforeReadFile" })).toBeNull();
    // An edit without a path is not a file change we can log.
    expect(cursor.parse({ ...common, hook_event_name: "afterFileEdit" })).toBeNull();
  });

  it("does not claim Claude Code or Codex payloads", () => {
    const claudeStop = { hook_event_name: "Stop", session_id: "s", cwd: "/repo" };
    const codexStop = { hook_event_name: "Stop", session_id: "s", turn_id: "t", cwd: "/repo" };
    expect(cursor.parse(claudeStop)).toBeNull();
    expect(cursor.parse(codexStop)).toBeNull();
    // ...and the other two must not claim Cursor's.
    const cursorStop = { ...common, hook_event_name: "stop" };
    expect(claudeCode.parse(cursorStop)).toBeNull();
    expect(codex.parse(cursorStop)).toBeNull();
  });
});
