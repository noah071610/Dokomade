/**
 * Turn -> one short line for the "작업" column.
 *
 * Strategy object, because the MVP summarizer must stay at zero tokens while
 * an AI summarizer can be swapped in later without touching the Stop hook.
 */
import type { FileChange } from "./markdown.js";

export interface TurnContext {
  promptText: string;
  labels: string[];
  files: FileChange[];
  lastAssistantMessage?: string;
}

export interface Summarizer {
  summarize(input: TurnContext): Promise<string>;
}

const MAX_LEN = 40;

/**
 * The tag the assistant is asked to append to its own reply.
 *
 * This is the whole "let the user's own AI title it" mechanism: a system
 * reminder injected at UserPromptSubmit asks for one tagged line, and the Stop
 * hook reads it back out of `last_assistant_message`. No extra model call, no
 * Bash tool call in the transcript, and no agent hook - so nothing here can
 * block a turn from ending.
 */
export const TITLE_TAG = "[dokomade]";

/** Instruction injected as a system reminder, invisible in the chat. */
export const TITLE_REQUEST = [
  `이 턴에서 파일을 수정했다면, 답변 맨 마지막 줄에 \`${TITLE_TAG} <제목>\` 형식으로 한 줄만 추가해라.`,
  "제목은 방금 한 일을 한국어 20자 이내로 요약한 명사형. 예: `어휘카드 뒤로가기 추가`.",
  "파일을 수정하지 않았으면 추가하지 마라. 그 줄 외에는 평소대로 답해라.",
].join(" ");

// Matches the tag anywhere on its own line; the assistant sometimes explains
// the convention before using it, so the last occurrence is the real one.
const TITLE_LINE = /^[ \t>*-]*\[dokomade\][ \t:]*(.+?)[ \t`]*$/gim;

function taggedTitle(message: string): string | null {
  const matches = [...message.matchAll(TITLE_LINE)];
  const last = matches.at(-1)?.[1]?.trim();
  return last ? last : null;
}

/**
 * Editors and Claude Code splice context blocks into the prompt before the
 * user's own words - `<ide_opened_file>`, `<system-reminder>`, slash-command
 * wrappers. Taken literally they become the log title, which is how a row ends
 * up reading "<ide_opened_file>The user opened the fi…".
 *
 * The closing tag may be missing when the block was truncated, so each pattern
 * also accepts end-of-string as its terminator.
 */
const INJECTED_BLOCK =
  /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Korean request endings that carry no information in a log row.
 *
 * Only the "하-" forms are stripped: "적용해줘" -> "적용" reads fine, but a bare
 * "줘" is part of the verb, and cutting it turns "붙여줘" into "붙여".
 */
const TRAILING_REQUEST =
  /\s*(?:좀\s*)?(?:해\s*(?:줘요?|주세요|주라|주실래요?|라|봐|줄래)|부탁\s*(?:해요?|드려요?|합니다)|주세요)\s*[.!?~]*$/;

/** Declarative endings the assistant closes a report with: "...수정했습니다." */
const TRAILING_DONE = /\s*(?:했|하였|되었|됐|완료했|추가했|수정했)(?:습니다|어요|음|다)\s*[.!?~]*$/;

/** Filler the user opens with: "일단 이거 ...", "그리고 ...". */
const LEADING_FILLER = /^(?:일단|그리고|근데|자|이제|아|음)\s+/;

function clean(text: string): string {
  return text
    .replace(INJECTED_BLOCK, "")
    // Any stray tag left over from a block we did not name above.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, "")
    .trim();
}

/**
 * A pasted JSON blob, error stack, or code fence is not the request - it is
 * material attached to it. "{"logDir": "docs...` truncated to 40 chars is a
 * useless title, and it also buries the sentence that follows ("이거 왜 안됨
 * 고쳐줘"). Detected by density of JSON/code punctuation, not by content.
 */
const LOOKS_LIKE_DATA =
  // Starts a block/array/tag/fence/keyword, is a `"key": value` JSON line, or
  // ends the way JSON/code lines do (`,` `{` `}` `[` `]` `;`).
  /^[{}[\]<]|^```|^\s*(?:const|function|import|export|class|def|SELECT)\b|^"[^"]*"\s*:|[,{}[\];]\s*$/;

function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !LOOKS_LIKE_DATA.test(trimmed);
}

function condense(text: string): string {
  const lines = clean(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Prefer the first line that reads as an instruction. A prompt that is
  // entirely pasted data (no prose line at all) falls back to the first line
  // rather than producing an empty title.
  const firstLine = lines.find(isProseLine) ?? lines[0] ?? "";

  let out = firstLine;
  // Users often stack two of these: "일단 그리고 ...".
  for (let i = 0; i < 2; i++) out = out.replace(LEADING_FILLER, "");
  out = out.replace(TRAILING_REQUEST, "").trim();
  if (out.length <= MAX_LEN) return out;
  return `${out.slice(0, MAX_LEN - 1).trimEnd()}…`;
}

/** Strip markdown so a heading or bullet does not leak into the table cell. */
function fromAssistant(message: string): string {
  const plain = clean(message)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = plain.split(/(?<=[.!?。])\s/)[0] ?? plain;
  return condense(sentence.replace(TRAILING_DONE, ""));
}

/**
 * Zero-token default. Priority order:
 *
 *   1. the `[dokomade] ...` line the assistant tagged its own reply with -
 *      it knows what it actually did, not just what was asked
 *   2. the user's prompt, in their words
 *   3. the assistant's closing sentence
 *   4. path-derived labels
 *
 * Every step degrades quietly: if the assistant never tagged a line, the row
 * still gets the title it would have had before.
 */
export class MechanicalSummarizer implements Summarizer {
  async summarize(input: TurnContext): Promise<string> {
    if (input.lastAssistantMessage) {
      const tagged = taggedTitle(input.lastAssistantMessage);
      if (tagged) return condense(tagged) || tagged.slice(0, MAX_LEN);
    }

    const fromPrompt = condense(input.promptText);
    if (fromPrompt) return fromPrompt;

    if (input.lastAssistantMessage) {
      const said = fromAssistant(input.lastAssistantMessage);
      if (said) return said;
    }

    const labels = input.labels.slice(0, 2).join(", ");
    return labels || "파일 수정";
  }
}

// TODO: AiSummarizer. Claude Code does support `"type": "prompt"` and
// `"type": "agent"` hook handlers, so this is buildable - but it must read the
// transcript from state.transcriptOffset forward, never the whole file, or the
// cost compounds every turn.
