/**
 * Turn -> the log row: what changed, and why it changed.
 *
 * Strategy object, because the MVP summarizer must stay at zero tokens while
 * an AI summarizer can be swapped in later without touching the Stop hook.
 */
import { normalizeScope, type WorkScope } from "./classify.js"
import type { FileChange } from "./markdown.js"

export interface TurnContext {
  labels: string[]
  files: FileChange[]
  lastAssistantMessage?: string
}

/** The summary and goal values written to separate log columns. */
export interface TurnSummary {
  summary: string
  /** Absent when the reply did not say - the row is still valid without it. */
  goal?: string
  scope: WorkScope
}

export interface Summarizer {
  summarize(input: TurnContext): Promise<TurnSummary>
}

/**
 * Hard ceiling on the Task cell. The prompt asks for `TITLE_TARGET`; this is
 * the backstop for a reply that ignores it, set high enough that a genuinely
 * detailed title survives intact rather than being cut mid-word.
 */
const MAX_LEN = 100
/** What the prompt asks for. A cell around this length reads well in a table. */
const TITLE_TARGET = 40

/**
 * The tags the assistant is asked to append to its own reply.
 *
 * This is the whole "let the user's own AI title it" mechanism: a system
 * reminder injected at UserPromptSubmit asks for the tagged lines, and the Stop
 * hook reads them back out of `last_assistant_message`. No extra model call, no
 * Bash tool call in the transcript, and no agent hook - so nothing here can
 * block a turn from ending.
 *
 * The names are plain English words rather than a namespaced `[dokomade]`,
 * which is a collision the tag names deliberately accept: across 269 recorded
 * sessions no assistant ever opened a line with `[summary]` on its own, and a
 * tag the model reads as meaningful is one it obeys more often.
 */
const TITLE_NAME = "summary"
const GOAL_NAME = "goal"
const SCOPE_NAME = "scope"
export const TITLE_TAG = `[${TITLE_NAME}]`
export const GOAL_TAG = `[${GOAL_NAME}]`
export const SCOPE_TAG = `[${SCOPE_NAME}]`

/**
 * Instruction injected as a system reminder, invisible in the chat.
 *
 * The length here is what actually decides the title, not `MAX_LEN`: the model
 * writes to whatever the prompt asks for, so the prompt asks for the length
 * worth reading and `MAX_LEN` only catches the replies that overshoot.
 *
 * All three lines are asked for on one line each. Task is a table cell and a
 * Notion title; Goal is its own text column.
 */
export const TITLE_REQUEST = [
  "파일을 수정했다면 응답의 마지막 세 줄에 반드시 아래 세 줄을 추가해라.",
  `${SCOPE_TAG} <Frontend, Backend, Core 중 하나 이상을 쉼표로 연결하거나 Etc>`,
  `${TITLE_TAG} <무엇을 바꿨는지, 바뀐 대상을 포함한 한국어 명사형 ${TITLE_TARGET}자 안팎, 최대 ${MAX_LEN}자>`,
  `${GOAL_TAG} <왜 바꿨는지, 한국어 ${TITLE_TARGET}자 안팎, 최대 ${MAX_LEN}자>`,
  `세 줄 다 짧게 줄이지 말고 ${TITLE_TARGET}자까지 채워서 구체적으로 써라. ${TITLE_TAG}는 무엇을 어떻게 바꿨는지, ${GOAL_TAG}는 그렇게 한 이유가 드러나야 한다.`,
  "'수정', '고쳤습니다', '완료'처럼 의미 없는 제목은 금지한다.",
  "세 줄 모두 반드시 한 줄로 써라. 줄바꿈, 목록, 코드블록 금지.",
  `${GOAL_TAG}에는 동기나 배경을 적고, ${TITLE_TAG} 내용을 다시 쓰지 마라.`,
  "파일을 수정하지 않았다면 세 줄 다 출력하지 마라.",
].join("\n")

// Matches a tag anywhere on its own line; the assistant sometimes explains the
// convention before using it, so the last occurrence is the real one.
const tagLine = (name: string): RegExp => new RegExp(`^[ \\t>*-]*\\[${name}\\][ \\t:]*(.+?)[ \\t\`]*$`, "gim")
const TITLE_LINE = tagLine(TITLE_NAME)
const GOAL_LINE = tagLine(GOAL_NAME)
const SCOPE_LINE = tagLine(SCOPE_NAME)
const LEGACY_GOAL_LINE = tagLine("why")

/** Every tag the reply might carry, including the retired one, for stripping. */
const ANY_TAG = new RegExp(`\\[(?:${TITLE_NAME}|${GOAL_NAME}|${SCOPE_NAME}|why|dokomade)\\]\\s*`, "gi")

function lastTagged(message: string, line: RegExp): string | null {
  return [...message.matchAll(line)].at(-1)?.[1]?.trim() || null
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
  /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi

/** Declarative endings the assistant closes a report with: "...수정했습니다." */
const TRAILING_DONE = /\s*(?:했|하였|되었|됐|완료했|추가했|수정했)(?:습니다|어요|음|다)\s*[.!?~]*$/
const GENERIC_SENTENCE =
  /^(?:네[, ]*)?(?:고쳤습니다|수정(?:했습니다)?|완료했습니다|반영했습니다|처리했습니다|해결했습니다|변경했습니다|추가했습니다|끝났습니다|됐습니다)[.!?~。]*$/

function clean(text: string): string {
  return (
    text
      .replace(INJECTED_BLOCK, "")
      // Any stray tag left over from a block we did not name above, plus the
      // `<br>` a model reaches for when it wants two lines in one cell. A
      // space, not nothing, so dropping a tag cannot weld two words together.
      .replace(/<[^>]*>/g, " ")
      .trim()
  )
}

/**
 * One line, at most `max` characters.
 *
 * A reply that wraps its title across two lines still means one title, so the
 * lines are joined rather than the first one kept - dropping the rest would
 * silently truncate at the wrap instead of at `max`.
 */
function condense(text: string, max = MAX_LEN): string {
  const out = clean(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (!out) return ""
  if (out.length <= max) return out
  return `${out.slice(0, max - 1).trimEnd()}…`
}

/** Strip markdown so a heading or bullet does not leak into the table cell. */
function fromAssistant(message: string): string {
  const plain = clean(message)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(ANY_TAG, "")
    .replace(/[`*_#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const sentence = plain.split(/(?<=[.!?。])\s+/).find((candidate) => !GENERIC_SENTENCE.test(candidate.trim())) ?? ""
  return condense(sentence.replace(TRAILING_DONE, ""))
}

function fromFiles(labels: string[], files: FileChange[]): string {
  const names = [
    ...new Set(
      files.map((file) =>
        file.path
          .split("/")
          .at(-1)
          ?.replace(/\.[^.]+$/, ""),
      ),
    ),
  ]
    .filter(Boolean)
    .slice(0, 2)
  return condense(names.length > 0 ? `${names.join(", ")} 변경` : labels.slice(0, 2).join(", "))
}

/**
 * Zero-token default. Priority order:
 *
 *   1. the `[summary] ...` line the assistant tagged its own reply with -
 *      it knows what it actually did, not just what was asked
 *   2. the assistant's closing sentence, which still describes the work
 *   3. path-derived title
 *
 * `goal` comes from its tag only. The fallbacks guess at what changed from
 * paths and stray prose; neither can know a motive, and inventing one would
 * be worse than leaving Goal empty.
 *
 * The prompt is deliberately not in this list. It is the request, not the
 * work: it carries throwaway wording ("이거 왜 이럼"), pasted data, and IDE
 * context blocks, and it says nothing about what the turn actually changed -
 * which is the one thing the row exists to record.
 */
export class MechanicalSummarizer implements Summarizer {
  async summarize(input: TurnContext): Promise<TurnSummary> {
    const message = input.lastAssistantMessage
    const scope = normalizeScope(message ? (lastTagged(message, SCOPE_LINE) ?? "") : "")
    if (message) {
      const title = lastTagged(message, TITLE_LINE)
      if (title && !GENERIC_SENTENCE.test(title)) {
        const goal = lastTagged(message, GOAL_LINE) ?? lastTagged(message, LEGACY_GOAL_LINE)
        return {
          summary: condense(title) || title.slice(0, MAX_LEN),
          goal: goal ? condense(goal) || undefined : undefined,
          scope,
        }
      }

      const said = fromAssistant(message)
      if (said) return { summary: said, scope }
    }

    return { summary: fromFiles(input.labels, input.files) || "파일 수정", scope }
  }
}

// TODO: AiSummarizer. It cannot be a hook handler: `"type": "prompt"` and
// `"type": "agent"` are only available on PreToolUse, PostToolUse and
// PermissionRequest, and Stop is not a tool event. Shelling out to the user's
// own CLI is the only route, and it has to read the transcript from
// state.transcriptOffset forward, never the whole file, or the cost compounds
// every turn - all inside the Stop hook's timeout.
