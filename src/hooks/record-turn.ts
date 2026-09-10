import fs from "node:fs"
import path from "node:path"
import { classifyAll } from "../core/classify.js"
import { authorName, changedSince, lineDeltas } from "../core/git.js"
import { appendRow, dateKey, logPath, timeKey, type AgentName, type FileChange } from "../core/markdown.js"
import {
  STATE_DIR,
  appendJSONL,
  claimPending,
  paths,
  readConfig,
  readState,
  recordPerf,
  repoRelativePath,
  writeJSON,
} from "../core/store.js"
import { MechanicalSummarizer } from "../core/summarize.js"

/** Record one turn; also used to recover a Stop hook that never ran. */
export async function recordTurn(
  root: string,
  agent: AgentName,
  lastAssistantMessage: string | undefined,
  hook: string,
  startedAt: number,
): Promise<boolean> {
  const p = paths(root)
  const { entries, claimed } = claimPending(p)

  try {
    const config = readConfig(p)
    const state = readState(p)
    const logDirPrefix = `${config.logDir.replace(/\/+$/, "")}/`
    const pendingPaths = entries.flatMap((entry) => {
      if (typeof entry.path !== "string") return []
      const relative = repoRelativePath(root, path.resolve(root, entry.path))
      return relative ? [relative] : []
    })
    const relPaths = [
      ...new Set(
        [...pendingPaths, ...(state.promptStartedAt ? changedSince(root, state.promptStartedAt) : [])].filter(
          (rel) => rel && !rel.startsWith(`${STATE_DIR}/`) && !rel.startsWith(logDirPrefix),
        ),
      ),
    ]
    if (relPaths.length === 0) return false

    const deltas = lineDeltas(root, relPaths)
    const files: FileChange[] = relPaths.map((rel) => ({
      path: rel,
      added: deltas.get(rel)?.added ?? 0,
      removed: deltas.get(rel)?.removed ?? 0,
    }))
    const labels = classifyAll(relPaths, config.classify)
    const { summary, goal, scope } = await new MechanicalSummarizer().summarize({
      labels,
      files,
      lastAssistantMessage,
    })

    const at = new Date()
    const author = authorName(root)
    appendRow(logPath(root, config.logDir, author, at), {
      at,
      summary,
      goal,
      files,
      durationMs: state.promptStartedAt ? at.getTime() - state.promptStartedAt : -1,
      agent,
      author,
      scope,
      status: "stage",
    })
    appendJSONL(p.queue, { date: dateKey(at), time: timeKey(at), files: relPaths })
    writeJSON(p.state, {
      ...state,
      lastPromptText: undefined,
      promptStartedAt: undefined,
      agent: undefined,
    })
    return true
  } finally {
    if (claimed) fs.rmSync(claimed, { force: true })
    recordPerf(p, hook, startedAt)
  }
}
