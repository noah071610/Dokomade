/**
 * Turn -> one short line for the "작업" column.
 *
 * Strategy object, because the MVP summarizer must stay at zero tokens while
 * an AI summarizer can be swapped in later without touching the Stop hook.
 */
import type { FileChange } from "./markdown.js";

export interface TurnContext {
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
export const TITLE_REQUEST = `파일을 수정했다면 마지막 줄에 \`${TITLE_TAG} <한국어 명사형 제목(20자 이내)>\`를 추가하고, 아니면 추가하지 마라.`;

// Matches the tag anywhere on its own line; the assistant sometimes explains
// the convention before using it, so the last occurrence is the real one.
const TITLE_LINE = /^[ \t>*-]*\[dokomade\][ \t:]*(.+?)[ \t`]*$/gim;

function taggedTitle(message: string): string | null {
  const matches = [...message.matchAll(TITLE_LINE)];
  const last = matches.at(-1)?.[1]?.trim();
  return last ? last : null;
}

/**
 * Editors and Claude Code splice context blocks into text - `<ide_opened_file>`,
 * `<system-reminder>`, slash-command wrappers - and the assistant quotes them
 * back often enough that a title can inherit one.
 *
 * The closing tag may be missing when the block was truncated, so each pattern
 * also accepts end-of-string as its terminator.
 */
const INJECTED_BLOCK =
  /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/** Declarative endings the assistant closes a report with: "...수정했습니다." */
const TRAILING_DONE = /\s*(?:했|하였|되었|됐|완료했|추가했|수정했)(?:습니다|어요|음|다)\s*[.!?~]*$/;

function clean(text: string): string {
  return text
    .replace(INJECTED_BLOCK, "")
    // Any stray tag left over from a block we did not name above.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, "")
    .trim();
}

function condense(text: string): string {
  const out = clean(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!out) return "";
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
 *   2. the assistant's closing sentence, which still describes the work
 *   3. path-derived labels
 *
 * The prompt is deliberately not in this list. It is the request, not the
 * work: it carries throwaway wording ("이거 왜 이럼"), pasted data, and IDE
 * context blocks, and it says nothing about what the turn actually changed -
 * which is the one thing the row exists to record.
 */
export class MechanicalSummarizer implements Summarizer {
  async summarize(input: TurnContext): Promise<string> {
    if (input.lastAssistantMessage) {
      const tagged = taggedTitle(input.lastAssistantMessage);
      if (tagged) return condense(tagged) || tagged.slice(0, MAX_LEN);

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
