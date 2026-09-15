import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";

const common = {
  conversation_id: "conv-1",
  workspace_roots: ["/repo"],
};

describe("cursor adapter", () => {
  beforeEach(() => vi.stubEnv("CURSOR_PROJECT_DIR", undefined));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["beforeSubmitPrompt", "afterFileEdit", "stop"])(
    "%s는 여러 폴더 중 CURSOR_PROJECT_DIR의 프로젝트를 선택한다",
    (hook_event_name) => {
      vi.stubEnv("CURSOR_PROJECT_DIR", "/second-repo");
      expect(cursor.parse({
        ...common,
        workspace_roots: ["/repo", "/second-repo"],
        hook_event_name,
        file_path: "/second-repo/changed.ts",
      })).toMatchObject({ cwd: "/second-repo" });
    },
  );

  it.each(["beforeSubmitPrompt", "afterFileEdit", "stop"])(
    "%s는 환경변수 없이 실행된 프로젝트 훅의 작업 폴더를 선택한다",
    (hook_event_name) => {
      vi.spyOn(process, "cwd").mockReturnValue("/second-repo");
      expect(cursor.parse({
        ...common,
        workspace_roots: ["/repo", "/second-repo/"],
        hook_event_name,
        file_path: "/second-repo/changed.ts",
      })).toMatchObject({ cwd: "/second-repo" });
    },
  );

  it("프로젝트 환경변수가 있으면 workspace_roots 없이도 사용한다", () => {
    vi.stubEnv("CURSOR_PROJECT_DIR", "/second-repo");
    expect(cursor.parse({ conversation_id: "conv-1", hook_event_name: "stop" }))
      .toMatchObject({ cwd: "/second-repo" });
  });

  it("프로젝트 정보가 없으면 작업 폴더를 사용한다", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/second-repo");
    expect(cursor.parse({ conversation_id: "conv-1", hook_event_name: "stop", workspace_roots: [] }))
      .toMatchObject({ cwd: "/second-repo" });
  });

  it("작업 폴더가 workspace 밖이면 첫 번째 유효한 루트를 사용한다", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/elsewhere");
    expect(cursor.parse({ ...common, hook_event_name: "stop", workspace_roots: [null, "", 123, "/repo"] }))
      .toMatchObject({ cwd: "/repo" });
  });

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
