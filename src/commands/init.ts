/**
 * `dokomade init` - create .dokomade/, register the hooks, fix .gitignore.
 *
 * The three hook registries all point at the same normalized scripts, but each
 * tool owns its own project config file - and Cursor also renames every event
 * and flattens the group layer away.
 *
 * Deliberately absent: a Stop `agent` hook that would have the user's own model
 * write the title. On Stop, an agent hook returning ok:false makes Claude keep
 * working, and agent hooks support neither `impossible` nor `continueOnBlock` -
 * so any failure (denied Bash, timeout) costs real turns. Measured, not
 * assumed: the first live run hit both.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { availableClis } from "../core/ai.js"
import {
  DEFAULT_COMMIT,
  DEFAULT_CONFIG,
  defaultLogDir,
  guessRoot,
  paths,
  readConfig,
  readJSON,
  writeConfig,
  writeJSON,
  type AiCliId,
  type Config,
  type Paths,
  type ProjectType,
} from "../core/store.js"
import { WORKFLOW_FILE, writeWorkflow } from "../core/workflow.js"

const HOOK_FILES = {
  UserPromptSubmit: "on-prompt.js",
  PostToolUse: "on-tool.js",
  Stop: "on-stop.js",
} as const

/**
 * PostToolUse is the only one of the three that supports a matcher. Filtering
 * at the group level means Claude Code never even spawns the hook process for
 * Read/Bash/Grep - far cheaper than spawning and exiting early.
 */
const FILE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit"
const CODEX_FILE_TOOL_MATCHER = "apply_patch"

/**
 * Cursor's own event names. `afterFileEdit` fires only for edits, so it needs
 * no matcher - the filtering FILE_TOOL_MATCHER does for Claude Code is built
 * into the event itself.
 */
const CURSOR_HOOK_FILES = {
  beforeSubmitPrompt: "on-prompt.js",
  afterFileEdit: "on-tool.js",
  stop: "on-stop.js",
} as const

const MARKER = "dokomade"

const GITIGNORE_ENTRIES = [
  ".claude",
  ".codex",
  ".cursor",
  ".env",
  ".dokomade/state.json",
  ".dokomade/pending.jsonl",
  ".dokomade/queue.jsonl",
  ".dokomade/perf.jsonl",
]

interface HookHandler {
  type: string
  command?: string
  prompt?: string
  model?: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>

/**
 * Cursor's hooks.json is flatter: an event maps straight to a list of
 * handlers, with no matcher-carrying group wrapped around them, and the file
 * carries a top-level `version`.
 */
type CursorHooks = { version?: number; hooks?: Record<string, HookHandler[]> } & Record<string, unknown>

// ANSI color and formatting utilities
const isColorSupported = !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR))

const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  gray: isColorSupported ? "\x1b[90m" : "",
  white: isColorSupported ? "\x1b[37m" : "",
}

const isUnicode = process.platform !== "win32" || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM)

const fig = {
  pointer: isUnicode ? "❯" : ">",
  radioOn: isUnicode ? "●" : "(*)",
  radioOff: isUnicode ? "○" : "( )",
  checkboxOn: isUnicode ? "◼" : "[x]",
  checkboxOff: isUnicode ? "◻" : "[ ]",
  tick: isUnicode ? "✔" : "√",
  step: isUnicode ? "◇" : "?",
  bullet: isUnicode ? "•" : "*",
  line: isUnicode ? "│" : "|",
  cornerTop: isUnicode ? "┌" : "+",
  cornerBottom: isUnicode ? "└" : "+",
  dash: isUnicode ? "-" : "-",
}

interface SelectItem<T = string> {
  label: string
  value: T
  description: string
}

const PROJECT_TYPES: SelectItem<ProjectType>[] = [
  { label: "Frontend", value: "frontend", description: "Client-side web, desktop, or mobile application" },
  { label: "Backend", value: "backend", description: "Server APIs, backend services, database routes" },
  { label: "Fullstack", value: "fullstack", description: "Combined frontend and backend monorepo" },
  {
    label: "Library / Extension",
    value: "library",
    description: "AI plugins, npm libraries, VS Code/Chrome extensions",
  },
]

const INTEGRATIONS: SelectItem<"Notion" | "Google Sheets">[] = [
  { label: "Notion", value: "Notion", description: "Sync work logs to a Notion database" },
  { label: "Google Sheets", value: "Google Sheets", description: "Append work logs to a spreadsheet" },
]

type IntegrationId = (typeof INTEGRATIONS)[number]["value"]

async function confirmPrompt(question: string, defaultValue: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`${c.green}${fig.tick}${c.reset}  ${question}: ${defaultValue ? "yes" : "no"}`)
    return defaultValue
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue ? " [Y/n] " : " [y/N] "
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase()
    if (!answer) return defaultValue
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

interface SelectPromptOptions<T> {
  title: string
  hint: string
  items: readonly SelectItem<T>[]
  multi: boolean
  initialSelected?: number[]
  required?: boolean
}

/** Terminal selector with modern colors, icons, and keyboard navigation. */
async function selectPrompt<T>(options: SelectPromptOptions<T>): Promise<number[]> {
  const { title, hint, items, multi, initialSelected = [], required = false } = options

  if (items.length === 0) {
    console.log(`${c.gray}${fig.line}  ${title}: no root folders found${c.reset}`)
    return []
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const fallback = multi ? initialSelected : [0]
    const fallbackLabels =
      fallback
        .map((i) => items[i]?.label)
        .filter(Boolean)
        .join(", ") || "None"
    console.log(`${c.green}${fig.tick}${c.reset}  ${c.bold}${title}:${c.reset} ${c.cyan}${fallbackLabels}${c.reset}`)
    return fallback
  }

  return new Promise((resolve) => {
    let cursor = 0
    const checked = new Set<number>(initialSelected)
    let rendered = false
    let done = false
    let buffer = ""

    const render = (): void => {
      if (rendered) {
        process.stdout.write("\x1b[u\x1b[J")
      } else {
        process.stdout.write("\x1b[s")
      }

      const lines = items.map((item, i) => {
        const isCurrent = i === cursor
        const isChecked = checked.has(i)

        let symbol = ""
        let labelText = ""
        if (multi) {
          symbol = isChecked
            ? `${c.green}${fig.checkboxOn}${c.reset}`
            : isCurrent
              ? `${c.cyan}${fig.checkboxOff}${c.reset}`
              : `${c.dim}${fig.checkboxOff}${c.reset}`
          labelText = isChecked
            ? `${c.bold}${c.white}${item.label}${c.reset}`
            : isCurrent
              ? `${c.white}${item.label}${c.reset}`
              : `${c.dim}${item.label}${c.reset}`
        } else {
          symbol = isCurrent ? `${c.cyan}${fig.radioOn}${c.reset}` : `${c.dim}${fig.radioOff}${c.reset}`
          labelText = isCurrent ? `${c.bold}${c.white}${item.label}${c.reset}` : `${c.dim}${item.label}${c.reset}`
        }

        const pointer = isCurrent ? `${c.cyan}${fig.pointer}${c.reset}` : " "
        const desc = item.description ? `  ${c.dim}${fig.dash} ${item.description}${c.reset}` : ""

        return `${c.dim}${fig.line}${c.reset}  ${pointer} ${symbol} ${labelText}${desc}`
      })

      process.stdout.write(lines.map((line) => `\x1b[2K\r${line}`).join("\n") + "\n")
      rendered = true
    }

    const cleanup = (): void => {
      done = true
      process.stdin.off("data", onData)
      process.stdin.pause()
      process.stdin.setRawMode?.(false)
      process.stdout.write("\x1b[?25h")
    }

    const finish = (): void => {
      if (multi && required && checked.size === 0) {
        process.stdout.write(
          `\n${c.yellow}${fig.step}${c.reset}  Select at least one folder with Spacebar, then press Enter to continue.\n`,
        )
        return
      }
      cleanup()
      if (rendered) {
        process.stdout.write("\x1b[u\x1b[1A\x1b[0J")
      }
      const selectedIndices = multi ? [...checked] : [cursor]
      const selectedText =
        selectedIndices
          .map((i) => items[i]?.label)
          .filter(Boolean)
          .join(", ") || `${c.dim}None${c.reset}`
      console.log(`${c.green}${fig.tick}${c.reset}  ${c.bold}${title}:${c.reset} ${c.cyan}${selectedText}${c.reset}`)
      console.log(`${c.dim}${fig.line}${c.reset}`)
      resolve(selectedIndices)
    }

    const onData = (input: string): void => {
      buffer += input
      while (buffer && !done) {
        if (buffer.startsWith("\u001b[") && buffer.length < 3) return
        const key = buffer.startsWith("\u001b[") ? buffer.slice(0, 3) : buffer.slice(0, 1)
        buffer = buffer.slice(key.length)

        if (key === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          process.exit(0)
        }
        if (key === "\u001b[A" || key === "k" || key === "K") {
          cursor = (cursor + items.length - 1) % items.length
        } else if (key === "\u001b[B" || key === "j" || key === "J") {
          cursor = (cursor + 1) % items.length
        } else if (multi && key === " ") {
          if (checked.has(cursor)) checked.delete(cursor)
          else checked.add(cursor)
        } else if (key === "\r" || key === "\n") {
          return finish()
        } else if (/^[1-9]$/.test(key)) {
          const numIdx = Number(key) - 1
          if (numIdx < items.length) {
            cursor = numIdx
            if (multi) {
              if (checked.has(cursor)) checked.delete(cursor)
              else checked.add(cursor)
            }
          }
        }
        render()
      }
    }

    console.log(`${c.cyan}${fig.step}${c.reset}  ${c.bold}${title}${c.reset} ${c.gray}${hint}${c.reset}`)
    process.stdin.setRawMode(true)
    process.stdin.setEncoding("utf8")
    process.stdin.resume()
    process.stdin.on("data", onData)
    process.stdout.write("\x1b[?25l")
    render()
  })
}

function rootFolders(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort()
}

async function selectRootFolders(root: string, title: string): Promise<string[]> {
  const folders = rootFolders(root)
  const selected = await selectPrompt({
    title,
    hint: "(Use ↑/↓ to navigate, Spacebar to select, Enter to continue)",
    items: folders.map((folder) => ({ label: folder, value: folder, description: "" })),
    multi: true,
    required: true,
  })
  return selected.map((i) => folders[i]).filter((folder): folder is string => Boolean(folder))
}

async function selectIntegrations(): Promise<Set<IntegrationId>> {
  if (await confirmPrompt("Skip API integrations?", true)) return new Set()
  const selected = await selectPrompt({
    title: "Select API integrations",
    hint: "(Use Space to toggle, Enter to confirm)",
    items: INTEGRATIONS,
    multi: true,
  })
  return new Set(selected.map((i) => INTEGRATIONS[i]?.value).filter((value): value is IntegrationId => Boolean(value)))
}

/**
 * Which CLI `dokomade commit` may fall back to from a bare terminal.
 *
 * Asked lazily on the first terminal commit rather than during init. Only CLIs
 * actually on PATH are offered, and "none" is always available and safe.
 */
export async function selectAiCli(): Promise<AiCliId> {
  const found = availableClis()
  if (found.length === 0) return "none"

  const items: SelectItem<AiCliId>[] = [
    ...found.map((id) => ({
      label: id,
      value: id as AiCliId,
      description: `run \`${id}\` to write the message (uses your own tokens)`,
    })),
    {
      label: "none",
      value: "none" as AiCliId,
      description: "print the brief instead; configure an AI CLI first",
    },
  ]
  const [index] = await selectPrompt({
    title: "Commit messages from a bare terminal",
    hint: "(the configured AI CLI writes the message)",
    items,
    multi: false,
  })
  return items[index ?? items.length - 1]?.value ?? "none"
}

async function setupConfig(root: string, preset?: ProjectType): Promise<Config> {
  let projectType = preset
  if (!projectType) {
    const [projectIndex] = await selectPrompt({
      title: "Select project type",
      hint: "(Use ↑/↓ or j/k to navigate, Enter to select)",
      items: PROJECT_TYPES,
      multi: false,
    })
    projectType = PROJECT_TYPES[projectIndex ?? 0]?.value ?? "fullstack"
  }

  const folders = {
    pageDirs: [] as string[],
    routeDirs: [] as string[],
  }
  if (projectType === "frontend") {
    folders.pageDirs = ["."]
  } else if (projectType === "fullstack") {
    // ponytail: a preset type means a non-interactive run - scan the whole tree
    folders.pageDirs = preset ? ["."] : await selectRootFolders(root, "Select frontend page folders")
  }
  if (projectType === "backend") {
    folders.routeDirs = ["."]
  } else if (projectType === "fullstack") {
    folders.routeDirs = preset ? ["."] : await selectRootFolders(root, "Select backend route folders")
  }

  const selectedIntegrations = await selectIntegrations()

  return {
    ...DEFAULT_CONFIG,
    commit: { ...DEFAULT_COMMIT },
    projectType,
    classify: {
      frontend: { pageDirs: folders.pageDirs, sharedDirs: [] },
      backend: { routeDirs: folders.routeDirs },
    },
    integrations: {
      notion: selectedIntegrations.has("Notion"),
      sheets: selectedIntegrations.has("Google Sheets"),
    },
  }
}

/** Absolute path to a built entry next to this file's own bundle. */
function hookScript(file: string): string {
  return fileURLToPath(new URL(`./hooks/${file}`, import.meta.url))
}

/** Same path, expressed relative to the project when it lives inside it. */
function hookTarget(root: string, file: string): string {
  const abs = hookScript(file)
  const rel = path.relative(root, abs)
  const inProject = !rel.startsWith("..") && !path.isAbsolute(rel)
  return inProject ? `$CLAUDE_PROJECT_DIR/${rel.split(path.sep).join("/")}` : abs
}

/**
 * Launch by direct node path (spec option 2). `npx` re-resolves the package on
 * every invocation, which costs hundreds of ms on a hook that fires per edit.
 * Whether to swap in a thin shim under .dokomade/bin/ is a decision for after
 * `dokomade status` reports real numbers - see perf.jsonl.
 */
function hookCommand(root: string, file: string): string {
  return `node "${hookTarget(root, file)}"`
}

/**
 * Cursor spawns project hooks with the project root as their working
 * directory, so a project-relative path resolves without `$CLAUDE_PROJECT_DIR`
 * or `git rev-parse` - one less thing that has to expand correctly. A hook
 * living outside the project (a global install) still needs the absolute path.
 *
 * No `timeout`: Cursor documents the field but not its unit, and guessing
 * wrong by a factor of 1000 would kill every hook. Its default is fine.
 */
function cursorHookCommand(root: string, file: string): string {
  const abs = hookScript(file)
  const rel = path.relative(root, abs)
  const inProject = !rel.startsWith("..") && !path.isAbsolute(rel)
  return inProject ? `node "${rel.split(path.sep).join("/")}"` : `node "${abs}"`
}

function codexHookCommand(root: string, file: string): string {
  const abs = hookScript(file)
  const rel = path.relative(root, abs)
  const inProject = !rel.startsWith("..") && !path.isAbsolute(rel)
  return inProject ? `node "$(git rev-parse --show-toplevel)/${rel.split(path.sep).join("/")}"` : `node "${abs}"`
}

/**
 * Recognise groups a previous `init` wrote, so re-running replaces them
 * instead of stacking another copy. Matching on the package name in the path
 * is not enough: with `$CLAUDE_PROJECT_DIR` or a global install the path never
 * contains it, and every `init` would register the hooks again.
 */
function isOurHandler(h: HookHandler): boolean {
  const entries = Object.values(HOOK_FILES)
  return (
    (typeof h.command === "string" && entries.some((f) => h.command!.includes(`hooks/${f}`))) ||
    (typeof h.prompt === "string" && h.prompt.startsWith(`${MARKER}:`))
  )
}

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some(isOurHandler)
}

function updateGitignore(root: string): string[] {
  const file = path.join(root, ".gitignore")
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e))
  if (missing.length === 0) return []
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  fs.appendFileSync(file, `${prefix}\n# dokomade runtime state\n${missing.join("\n")}\n`)
  return missing
}

/**
 * A re-run of `init` on a project that already has logs is normally a config
 * change, not a fresh start - so the wipe is opt-in and asked only when there
 * is something to wipe. Runtime state goes with the logs: state.json and the
 * jsonl ledgers point at rows that would no longer exist.
 */
async function resetLogs(root: string, logDir: string, p: Paths): Promise<boolean> {
  const dir = path.join(root, logDir)
  if (!fs.existsSync(dir)) return false
  if (!(await confirmPrompt(`Delete existing logs in ${logDir}/ and start over?`, false))) return false
  fs.rmSync(dir, { recursive: true, force: true })
  for (const file of [p.state, p.pending, p.queue, p.perf]) fs.rmSync(file, { force: true })
  return true
}

export async function init(cwd: string = process.cwd(), projectType?: ProjectType): Promise<void> {
  const root = guessRoot(cwd)
  const p = paths(root)

  console.log(`\n${c.cyan}${fig.cornerTop}${c.reset}  ${c.bold}${c.white}dokomade${c.reset} ${c.dim}init${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}  ${c.dim}Project root:${c.reset} ${c.cyan}${root}${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}`)

  fs.mkdirSync(p.dir, { recursive: true })
  const existing = readConfig(p)
  const wiped = await resetLogs(root, existing.logDir, p)
  const configured = await setupConfig(root, projectType)
  // A logDir init picked itself is re-picked, so installing into a second
  // package and re-running init moves new logs to the top level. A hand-set one stays.
  const picked =
    existing.logDir === DEFAULT_CONFIG.logDir || existing.logDir.endsWith(`/${DEFAULT_CONFIG.logDir}`)
  const config: Config = {
    ...configured,
    logDir: picked ? defaultLogDir(root) : existing.logDir,
    integrations: existing.integrations ?? configured.integrations,
    commit: {
      ...configured.commit,
      ai: existing.commit.ai,
      aiConfigured: existing.commit.aiConfigured,
    },
  }
  writeConfig(p, config)

  // The sync workflow is generated, never hand-edited, so an existing copy is
  // stale rather than customised - refresh it whenever an integration is on.
  const syncing = config.integrations.notion || config.integrations.sheets
  if (syncing) writeWorkflow(root, config.logDir)

  const settingsFile = path.join(root, ".claude", "settings.json")
  const settings = readJSON<Settings>(settingsFile, {})
  settings.hooks ??= {}

  for (const [event, file] of Object.entries(HOOK_FILES)) {
    const others = (settings.hooks[event] ?? []).filter((g) => !isOurs(g))
    const group: HookGroup = {
      hooks: [{ type: "command", command: hookCommand(root, file), timeout: 10 }],
    }
    if (event === "PostToolUse") group.matcher = FILE_TOOL_MATCHER
    settings.hooks[event] = [...others, group]
  }
  writeJSON(settingsFile, settings)

  const codexHooksFile = path.join(root, ".codex", "hooks.json")
  const codexHooks = readJSON<Settings>(codexHooksFile, {})
  codexHooks.hooks ??= {}
  for (const [event, file] of Object.entries(HOOK_FILES)) {
    const others = (codexHooks.hooks[event] ?? []).filter((g) => !isOurs(g))
    const group: HookGroup = {
      hooks: [{ type: "command", command: codexHookCommand(root, file), timeout: 10 }],
    }
    if (event === "PostToolUse") group.matcher = CODEX_FILE_TOOL_MATCHER
    codexHooks.hooks[event] = [...others, group]
  }
  writeJSON(codexHooksFile, codexHooks)

  const cursorHooksFile = path.join(root, ".cursor", "hooks.json")
  const cursorHooks = readJSON<CursorHooks>(cursorHooksFile, {})
  cursorHooks.version = 1
  cursorHooks.hooks ??= {}
  for (const [event, file] of Object.entries(CURSOR_HOOK_FILES)) {
    const others = (cursorHooks.hooks[event] ?? []).filter((h) => !isOurHandler(h))
    cursorHooks.hooks[event] = [...others, { type: "command", command: cursorHookCommand(root, file) }]
  }
  writeJSON(cursorHooksFile, cursorHooks)

  const ignored = updateGitignore(root)

  console.log(`${c.green}${fig.cornerBottom}${c.reset}  ${c.green}${c.bold}Configuration complete!${c.reset}\n`)
  console.log(`${c.green}${fig.tick}${c.reset} ${c.bold}dokomade initialized at ${c.cyan}${root}${c.reset}\n`)
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}state${c.reset}        ${path.relative(root, p.dir) || ".dokomade"}/`,
  )
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}hooks${c.reset}        ${path.relative(root, settingsFile)}, ${path.relative(root, codexHooksFile)}, ${path.relative(root, cursorHooksFile)} ${c.gray}(prompt, file edit, stop)${c.reset}`,
  )
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}project${c.reset}      ${c.bold}${config.projectType}${c.reset}`,
  )
  const activeIntegrations = Object.entries(config.integrations)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ")
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}integrations${c.reset} ${activeIntegrations || c.gray + "none" + c.reset}`,
  )
  if (syncing) {
    console.log(
      `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}sync${c.reset}         ${WORKFLOW_FILE} ${c.gray}(runs on push; add secrets with \`npx dokomade connect <service>\`)${c.reset}`,
    )
  }
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}logs${c.reset}         ${config.logDir}/<author>/<YYYY-MM-DD>.md`,
  )
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}titles${c.reset}       mechanical ${c.gray}(0 tokens)${c.reset}`,
  )
  console.log(
    `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}commit${c.reset}       ${c.bold}npx dokomade commit${c.reset} ${c.gray}in a terminal (${
      !config.commit.aiConfigured
        ? "asks on first terminal commit"
        : config.commit.ai === "none"
          ? "configure an AI CLI first"
          : `falls back to ${config.commit.ai}`
    })${c.reset}`,
  )
  if (wiped) {
    console.log(
      `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}reset${c.reset}        ${c.yellow}${config.logDir}/ and runtime state deleted${c.reset}`,
    )
  }
  if (ignored.length > 0) {
    console.log(
      `  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}gitignore${c.reset}    ${c.green}+${ignored.length} entries${c.reset}`,
    )
  }
  console.log(
    `\n${c.yellow}${fig.bullet}${c.reset} ${c.bold}Next step:${c.reset} Restart Claude Code/Codex/Cursor (or run /hooks) so it picks up the new settings.`,
  )
  // Codex refuses to execute an untrusted hook - silently, with no error and no
  // log line. Until the review is accepted, .codex/hooks.json is registered but
  // dead, which looks exactly like "Codex ignores dokomade".
  console.log(
    `${c.yellow}${fig.bullet}${c.reset} ${c.bold}Codex only:${c.reset} start ${c.cyan}codex${c.reset} interactively once in this project and ${c.bold}approve the hooks review${c.reset} at startup.`,
  )
  console.log(
    `  ${c.gray}Until then Codex skips every dokomade hook without an error. \`codex exec\` cannot approve them.${c.reset}\n`,
  )
}
