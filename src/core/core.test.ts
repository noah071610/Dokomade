import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classify, classifyAll, SHARED_LABEL } from "./classify.js";
import { authorName, changedSince } from "./git.js";
import {
  appendRow,
  formatDuration,
  formatFiles,
  formatRow,
  logPath,
  recentLogFiles,
  rowsWithStatus,
  setStatus,
  splitCells,
  statusOf,
  timeKey,
  upgradeHeader,
  withStatus,
} from "./markdown.js";
import { retitle } from "../commands/retitle.js";
import { MechanicalSummarizer } from "./summarize.js";
import { DEFAULT_CONFIG, findRoot, paths, readConfig, writeJSON } from "./store.js";
import { CLOSE_MARK, OPEN_MARK, extractMessage } from "./ai.js";

const cfg = DEFAULT_CONFIG.classify;

describe("classify", () => {
  it("maps a frontend file to its page, not its component", () => {
    expect(classify("src/app/calculator/page.tsx", cfg)).toBe("calculator");
    expect(classify("src/app/calculator/bottom-sheet.tsx", cfg)).toBe("calculator");
  });

  it("maps a backend file to its REST domain", () => {
    expect(classify("src/api/users/route.ts", cfg)).toBe("users");
  });

  it("uses the project root when a single-stack config has a root marker", () => {
    expect(
      classify("src/app/page.tsx", {
        frontend: { pageDirs: ["."], sharedDirs: [] },
        backend: { routeDirs: [] },
      }),
    ).toBe("src");
  });

  it("buckets shared components separately from pages", () => {
    expect(classify("src/components/main-header.tsx", cfg)).toBe(SHARED_LABEL);
  });

  it("strips the extension when the page is a bare file", () => {
    expect(classify("src/pages/settings.tsx", cfg)).toBe("settings");
  });

  it("falls back to the parent directory for unconfigured paths", () => {
    expect(classify("src/i18n/ko.json", cfg)).toBe("i18n");
  });

  it("orders labels by how many files each covers", () => {
    expect(
      classifyAll(
        ["src/api/users/route.ts", "src/app/calculator/page.tsx", "src/app/calculator/x.tsx"],
        cfg,
      ),
    ).toEqual(["calculator", "users"]);
  });
});

describe("config", () => {
  it("accepts library and extension projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-config-"));
    fs.mkdirSync(path.join(root, ".dokomade"));
    writeJSON(paths(root).config, { projectType: "library" });

    expect(readConfig(paths(root)).projectType).toBe("library");
  });
});

describe("markdown", () => {
  it("renders the file cell as basename +add/-del joined by <br>", () => {
    expect(
      formatFiles([
        { path: "src/app/calculator/page.tsx", added: 42, removed: 13 },
        { path: "src/i18n/ko.json", added: 24, removed: 0 },
      ]),
    ).toBe("`page.tsx` +42/-13<br>`ko.json` +24/-0");
  });

  it("formats durations by magnitude", () => {
    expect(formatDuration(35_000)).toBe("35s");
    expect(formatDuration(4 * 60_000)).toBe("4m");
    expect(formatDuration(62 * 60_000)).toBe("1h2m");
    expect(formatDuration(-1)).toBe("-");
  });

  it("escapes pipes so a summary cannot break the table", () => {
    const row = formatRow({
      at: new Date(2026, 8, 6, 14, 11),
      summary: "a | b",
      files: [{ path: "x.ts", added: 1, removed: 0 }],
      durationMs: 4 * 60_000,
      author: "noah",
    });
    expect(row).toBe("| 14:11 | a \\| b | `x.ts` +1/-0 | 4m | noah | stage |");
    // Cell delimiters are the unescaped pipes: 6 columns -> 7 delimiters.
    expect(row.replace(/\\\|/g, "").split("|").length - 1).toBe(7);
    // An escaped pipe must not shift 상태 into the 작성자 slot.
    expect(splitCells(row)).toHaveLength(6);
    expect(statusOf(row)).toBe("stage");
  });
});

describe("MechanicalSummarizer", () => {
  const s = new MechanicalSummarizer();

  it("takes the line the assistant tagged", async () => {
    expect(
      await s.summarize({
        labels: ["vocab"],
        files: [],
        lastAssistantMessage: "원인 찾았습니다.\n\n[dokomade] 어휘카드 뒤로가기 수정",
      }),
    ).toBe("어휘카드 뒤로가기 수정");
  });

  it("takes the last tag when the assistant also explains the convention", async () => {
    expect(
      await s.summarize({
        labels: [],
        files: [],
        lastAssistantMessage: "형식은 `[dokomade] <제목>` 입니다.\n- [dokomade] 로그인 폼 검증 추가",
      }),
    ).toBe("로그인 폼 검증 추가");
  });

  it("falls back to what the assistant said, stripped of markdown", async () => {
    expect(
      await s.summarize({
        labels: ["auth"],
        files: [],
        lastAssistantMessage: "**로그인 리다이렉트 수정**했습니다. `auth.ts`를 고쳤어요.",
      }),
    ).toBe("로그인 리다이렉트 수정");
  });

  it("strips IDE context blocks the assistant quoted back", async () => {
    expect(
      await s.summarize({
        labels: ["vite.config"],
        files: [],
        lastAssistantMessage:
          "<ide_opened_file>The user opened the file /x/vite.config.ts in the IDE.</ide_opened_file>\n[dokomade] 어휘카드 뒤로가기 추가",
      }),
    ).toBe("어휘카드 뒤로가기 추가");
  });

  it("never titles a row from the prompt", async () => {
    // The request is not the work: an untagged turn falls through to labels
    // rather than echoing whatever the user typed.
    expect(
      await s.summarize({
        labels: ["users"],
        files: [],
        lastAssistantMessage: "<ide_opened_file>The user opened a file</ide_opened_file>",
      }),
    ).toBe("users");
  });

  it("falls back to labels when there is nothing else", async () => {
    expect(await s.summarize({ labels: ["users"], files: [] })).toBe("users");
  });

  it("has a title even with no labels", async () => {
    expect(await s.summarize({ labels: [], files: [] })).toBe("파일 수정");
  });
});

describe("findRoot boundaries", () => {
  const mk = (...segs: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-"));
    const deep = path.join(dir, ...segs);
    fs.mkdirSync(deep, { recursive: true });
    return dir;
  };

  it("finds .dokomade from a nested subdirectory", () => {
    const root = mk("packages", "web", "src");
    fs.mkdirSync(path.join(root, ".dokomade"));
    expect(fs.realpathSync(findRoot(path.join(root, "packages/web/src"))!)).toBe(
      fs.realpathSync(root),
    );
  });

  it("stops at a repo boundary that has no .dokomade", () => {
    const outer = mk("inner", "src");
    fs.mkdirSync(path.join(outer, ".dokomade"));
    fs.mkdirSync(path.join(outer, "inner", ".git"));
    // `inner` is its own repo and was never initialised, so the outer
    // .dokomade must not capture it.
    expect(findRoot(path.join(outer, "inner/src"))).toBeNull();
  });
});

describe("retitle", () => {
  const setup = (time: string): { root: string; file: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-rt-"));
    fs.mkdirSync(path.join(root, ".dokomade"));
    const file = logPath(root, DEFAULT_CONFIG.logDir, authorName(root), new Date());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `| ${time} | 기계 제목 | \`a.ts\` +1/-0 | 2m | x |\n`);
    return { root, file };
  };

  it("replaces only the title cell of the row just written", () => {
    const { root, file } = setup(timeKey(new Date()));
    retitle("어휘카드 다크모드 추가", root);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(
      "| " + timeKey(new Date()) + " | 어휘카드 다크모드 추가 | `a.ts` +1/-0 | 2m | x |",
    );
  });

  it("refuses a row old enough to belong to earlier work", () => {
    // A slow or retried agent must not relabel a row from hours ago.
    const { root, file } = setup("03:00");
    const before = fs.readFileSync(file, "utf8");
    retitle("덮어쓰면 안 됨", root);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("changedSince", () => {
  const repo = (): string => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-gs-")));
    execFileSync("git", ["-C", root, "init", "-q"]);
    const ignore = path.join(root, ".gitignore");
    fs.writeFileSync(ignore, "ignored/\n");
    // Backdate the fixture itself so it never lands inside the turn window.
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(ignore, old, old);
    return root;
  };

  const touch = (root: string, rel: string, at: number): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x\n");
    fs.utimesSync(abs, at / 1000, at / 1000);
  };

  it("sees a file a Bash heredoc rewrote, and ignores one from before the turn", () => {
    const root = repo();
    const turnStart = Date.now();
    touch(root, "stale.ts", turnStart - 60_000);
    touch(root, "src/edited.ts", turnStart + 1_000);

    expect(changedSince(root, turnStart)).toEqual(["src/edited.ts"]);
  });

  it("never reports a gitignored path", () => {
    const root = repo();
    const turnStart = Date.now();
    touch(root, "ignored/build.js", turnStart + 1_000);
    touch(root, "kept.ts", turnStart + 1_000);

    expect(changedSince(root, turnStart)).toEqual(["kept.ts"]);
  });

  it("returns nothing outside a git repo", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-nogit-"));
    expect(changedSince(bare, 0)).toEqual([]);
  });
});

describe("status column", () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "dkmd-st-"));

  it("treats a row written before the column existed as stage", () => {
    expect(statusOf("| 14:00 | 뭔가 함 | `x.ts` +1/-0 | 2m | noah |")).toBe("stage");
  });

  it("ignores a status cell holding something that is not a status", () => {
    expect(statusOf("| 14:00 | a | - | - | noah | 아무말 |")).toBe("stage");
  });

  it("appends the cell to a legacy row rather than overwriting 작성자", () => {
    const row = withStatus("| 14:00 | a | - | 2m | noah |", "commit");
    expect(splitCells(row)).toEqual(["14:00", "a", "-", "2m", "noah", "commit"]);
  });

  it("widens a header a formatter has already padded", () => {
    const root = tmp();
    const file = path.join(root, "2026-09-07.md");
    fs.writeFileSync(
      file,
      [
        "# 2026-09-07 — noah",
        "",
        "| 시각  | 작업 | 파일 | 소요 | 작성자 |",
        "| ----- | ---- | ---- | ---- | ------ |",
        "| 14:00 | a    | -    | 2m   | noah   |",
        "",
      ].join("\n"),
    );
    upgradeHeader(file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    expect(splitCells(lines[2] as string)).toHaveLength(6);
    expect(splitCells(lines[3] as string)).toHaveLength(6);
    // Rewriting the header must not disturb the rows under it.
    expect(lines[4]).toBe("| 14:00 | a    | -    | 2m   | noah   |");
  });

  it("moves only the rows in the requested state, and reports the count", () => {
    const root = tmp();
    const file = path.join(root, "log.md");
    fs.writeFileSync(
      file,
      [
        "| 시각 | 작업 | 파일 | 소요 | 작성자 | 상태 |",
        "| ---- | ---- | ---- | ---- | ------ | ---- |",
        "| 14:00 | a | - | - | noah | stage |",
        "| 14:10 | b | - | - | noah | commit |",
        "| 14:20 | c | - | - | noah | stage |",
        "",
      ].join("\n"),
    );
    expect(setStatus([file], "stage", "commit")).toEqual([{ file, rows: 2 }]);
    expect(rowsWithStatus([file], "stage")).toEqual([]);
    expect(rowsWithStatus([file], "commit").map((r) => r.time)).toEqual([
      "14:00",
      "14:10",
      "14:20",
    ]);
  });

  it("un-escapes the pipe when reading a summary back out", () => {
    const root = tmp();
    const file = path.join(root, "log.md");
    const at = new Date(2026, 8, 7, 14, 0);
    appendRow(file, { at, summary: "a | b", files: [], durationMs: -1, author: "noah" });
    expect(rowsWithStatus([file], "stage")[0]?.summary).toBe("a | b");
  });

  it("scans the window, not just today, so an overnight row is still found", () => {
    const root = tmp();
    const now = new Date(2026, 8, 7, 9, 0);
    const yesterday = new Date(2026, 8, 6, 23, 50);
    appendRow(logPath(root, "docs", "noah", yesterday), {
      at: yesterday,
      summary: "밤샘",
      files: [],
      durationMs: -1,
      author: "noah",
    });
    expect(recentLogFiles(root, "docs", "noah", 1, now)).toEqual([]);
    const week = recentLogFiles(root, "docs", "noah", 7, now);
    expect(week).toHaveLength(1);
    expect(rowsWithStatus(week, "stage")[0]?.summary).toBe("밤샘");
  });
});

describe("extractMessage", () => {
  it("pulls the message out of a CLI's surrounding chatter", () => {
    expect(
      extractMessage(
        [
          "[2026-09-07] session abc123",
          "thinking…",
          OPEN_MARK,
          "feat(log): add status column",
          "",
          "body line",
          CLOSE_MARK,
          "tokens used: 812",
        ].join("\n"),
      ),
    ).toBe("feat(log): add status column\n\nbody line");
  });

  it("falls back to the whole output when the model skipped the marker", () => {
    expect(extractMessage("```\nfix(api): handle null\n```\n")).toBe("fix(api): handle null");
  });
});
