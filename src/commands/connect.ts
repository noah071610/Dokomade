import { execFileSync } from "node:child_process"
import readline from "node:readline/promises"
import { ignoreEnvFile, writeEnvFile } from "../core/env.js"
import { isRepo } from "../core/git.js"
import { findRoot, paths, readConfig, safeRelativePath, writeConfig } from "../core/store.js"
import { WORKFLOW_FILE, writeWorkflow } from "../core/workflow.js"

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
  tick: isUnicode ? "✔" : "√",
  step: isUnicode ? "◇" : "?",
  bullet: isUnicode ? "•" : "*",
  line: isUnicode ? "│" : "|",
  cornerTop: isUnicode ? "┌" : "+",
  cornerBottom: isUnicode ? "└" : "+",
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
}

interface AskOptions {
  mask?: boolean
  hint?: string
  defaultPrompt?: string
}

/**
 * Prompt for sensitive inputs (API key, token, JSON secret) by displaying '*'
 * corresponding to the character length, keeping credentials private.
 */
async function askMasked(label: string, hint: string): Promise<string> {
  return new Promise((resolve) => {
    let value = ""
    let inPaste = false

    const promptText = `${c.cyan}${fig.step}${c.reset}  ${c.bold}${label}${c.reset}${hint ? ` ${c.gray}${hint}${c.reset}` : ""}: `
    process.stdout.write(promptText)

    process.stdout.write("\x1b[?2004h")
    process.stdin.setRawMode(true)
    process.stdin.setEncoding("utf8")
    process.stdin.resume()

    const cleanup = (): void => {
      process.stdout.write("\x1b[?2004l")
      process.stdin.off("data", onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }

    const finish = (): void => {
      cleanup()
      const promptLen = stripAnsi(promptText).length
      const cols = process.stdout.columns || 80
      const totalLen = promptLen + value.length
      const rows = Math.floor(totalLen / cols)

      if (rows > 0) {
        process.stdout.write(`\x1b[${rows}A\r\x1b[J`)
      } else {
        process.stdout.write("\r\x1b[2K")
      }

      const masked = "*".repeat(value.length)
      console.log(
        `${c.green}${fig.tick}${c.reset}  ${c.bold}${label}:${c.reset} ${c.dim}${masked || "(empty)"}${c.reset}`,
      )
      console.log(`${c.dim}${fig.line}${c.reset}`)
      resolve(value.trim())
    }

    const onData = (chunk: string | Buffer): void => {
      let str = typeof chunk === "string" ? chunk : chunk.toString("utf8")

      if (str.includes("\x1b[200~")) {
        inPaste = true
        str = str.replace("\x1b[200~", "")
      }
      if (str.includes("\x1b[201~")) {
        inPaste = false
        const parts = str.split("\x1b[201~")
        const pastedChunk = parts[0] ?? ""
        value += pastedChunk
        process.stdout.write("*".repeat(pastedChunk.length))
        str = parts[1] ?? ""
      }
      if (inPaste) {
        value += str
        process.stdout.write("*".repeat(str.length))
        return
      }

      str = str.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "")
      if (!str) return

      for (let i = 0; i < str.length; i++) {
        const ch = str[i]
        if (!ch) continue

        if (ch === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          process.exit(0)
        }

        if (ch === "\r" || ch === "\n") {
          finish()
          return
        }

        if (ch === "\x7f" || ch === "\b" || ch === "\x08") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write("\b \b")
          }
          continue
        }

        if (ch === "\u0015") {
          if (value.length > 0) {
            process.stdout.write("\b \b".repeat(value.length))
            value = ""
          }
          continue
        }

        const code = ch.charCodeAt(0)
        if (code >= 32 || code > 127) {
          value += ch
          process.stdout.write("*")
        }
      }
    }

    process.stdin.on("data", onData)
  })
}

/** Standard interactive text prompt */
async function askText(label: string, hint: string, defaultPrompt?: string): Promise<string> {
  const promptText = `${c.cyan}${fig.step}${c.reset}  ${c.bold}${label}${c.reset}${hint ? ` ${c.gray}${hint}${c.reset}` : ""}: `
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const rawAnswer = await rl.question(promptText)
    const answer = rawAnswer.trim()

    process.stdout.write("\x1b[1A\x1b[2K\r")
    const displayValue = answer
      ? `${c.cyan}${answer}${c.reset}`
      : defaultPrompt
        ? `${c.dim}(default: ${defaultPrompt})${c.reset}`
        : `${c.dim}(empty)${c.reset}`
    console.log(`${c.green}${fig.tick}${c.reset}  ${c.bold}${label}:${c.reset} ${displayValue}`)
    console.log(`${c.dim}${fig.line}${c.reset}`)
    return answer
  } finally {
    rl.close()
  }
}

async function ask(label: string, options: AskOptions = {}): Promise<string> {
  const { mask = false, hint = "", defaultPrompt } = options

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      const promptSuffix = hint ? ` ${hint}: ` : ": "
      return (await rl.question(`${label}${promptSuffix}`)).trim()
    } finally {
      rl.close()
    }
  }

  if (mask) {
    return askMasked(label, hint)
  }
  return askText(label, hint, defaultPrompt)
}

/**
 * What to set up before the credentials are worth anything.
 *
 * Printed rather than checked: the two failures below are the ones every
 * first-time setup hits, they surface as a bare 404 or a 400 naming one
 * property, and neither is guessable from the error alone.
 */
const SETUP: Record<"notion" | "sheets", string[]> = {
  notion: [
    "1. Create an internal integration at https://www.notion.so/my-integrations",
    "2. Open the target database, ... menu > Connections > add that integration.",
    "   Skipping this is what a 404 on every row means.",
    "3. Give the database exactly these properties:",
    "     Task (title)   Goal (text)     Files (text)    Lines (text)",
    "     Duration (text) AI (select)    Scope (text)    Status (select)",
    "     Author (text)  Date (date) [last two columns]",
    "   Scope values: Frontend / Backend / Core / Etc; combinations use commas.",
    "   Notion creates the select options itself; a wrong type fails with a",
    "   400 that names the property.",
  ],
  sheets: [
    "1. Create a service account and a JSON key in Google Cloud Console",
    "2. Enable the Google Sheets API for that project",
    "3. Share the spreadsheet with the service account's client_email as Editor.",
    "   Without that share every request answers 403.",
  ],
}

function formatSetupLine(line: string): string {
  const trimmed = line.trim()
  const leadingSpaces = line.slice(0, line.indexOf(trimmed))

  const stepMatch = trimmed.match(/^(\d+\.)\s*(.*)$/)
  if (stepMatch && stepMatch[1] && stepMatch[2] !== undefined) {
    const num = stepMatch[1]
    const rest = stepMatch[2]
    const highlightedRest = rest.replace(/(https?:\/\/[^\s]+)/g, `${c.cyan}$1${c.reset}`)
    return `${leadingSpaces}${c.cyan}${c.bold}${num}${c.reset} ${c.white}${highlightedRest}${c.reset}`
  }

  if (trimmed.includes("404") || trimmed.includes("403") || trimmed.includes("400")) {
    return `${leadingSpaces}${c.yellow}${trimmed}${c.reset}`
  }

  if (
    trimmed.includes("(title)") ||
    trimmed.includes("(text)") ||
    trimmed.includes("(select)") ||
    trimmed.includes("(date)")
  ) {
    const formatted = trimmed
      .replace(/(\w+)\s*\((title|text|select|date)\)/g, `${c.cyan}$1${c.reset} ${c.dim}($2)${c.reset}`)
      .replace(/\[last column\]/g, `${c.gray}[last column]${c.reset}`)
    return `${leadingSpaces}${formatted}`
  }

  return `${leadingSpaces}${c.dim}${trimmed}${c.reset}`
}

function setSecret(name: string, value: string): void {
  execFileSync("gh", ["secret", "set", name], { input: `${value}\n`, stdio: ["pipe", "inherit", "inherit"] })
}

async function chooseLocalEnv(): Promise<boolean> {
  console.log(
    `\n${c.yellow}${fig.step}${c.reset} ${c.bold}No Git repository found.${c.reset} GitHub Actions secrets need a GitHub repository.`,
  )
  console.log(
    `  ${c.dim}The credentials can be stored in a local .env file instead. Never commit or share that file.${c.reset}`,
  )
  return /^(y|yes)$/i.test(await ask("Store credentials in local .env instead? [y/N]"))
}

export async function connect(service: string, cwd: string = process.cwd()): Promise<void> {
  const root = findRoot(cwd)
  if (!root) {
    console.error(
      `\n${c.yellow}${fig.step}${c.reset} ${c.bold}connect:${c.reset} dokomade is not initialised here. Run ${c.cyan}dokomade init${c.reset} first.\n`,
    )
    process.exitCode = 1
    return
  }
  if (service !== "notion" && service !== "sheets") {
    console.error(
      `\n${c.yellow}${fig.step}${c.reset} ${c.bold}connect:${c.reset} choose ${c.cyan}notion${c.reset} or ${c.cyan}sheets${c.reset}\n`,
    )
    process.exitCode = 1
    return
  }
  const integration = service as "notion" | "sheets"
  const config = readConfig(paths(root))
  const localEnv = !isRepo(root)

  if (localEnv && !(await chooseLocalEnv())) {
    console.log(`\n${c.dim}${fig.line}  No credentials were saved. Exiting.${c.reset}\n`)
    return
  }

  const serviceTitle = integration === "notion" ? "Notion" : "Google Sheets"

  console.log(
    `\n${c.cyan}${fig.cornerTop}${c.reset}  ${c.bold}${c.white}dokomade${c.reset} ${c.dim}connect · ${service}${c.reset}`,
  )
  console.log(`${c.dim}${fig.line}${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}  ${c.bold}${c.white}Prerequisites for ${serviceTitle} Integration:${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}`)

  const setup = [...SETUP[integration]]
  for (const line of setup) {
    console.log(`${c.dim}${fig.line}${c.reset}  ${formatSetupLine(line)}`)
  }

  console.log(`${c.dim}${fig.line}${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}  ${c.bold}${c.white}Configure secrets:${c.reset}`)
  console.log(`${c.dim}${fig.line}${c.reset}`)

  try {
    if (service === "notion") {
      const token = await ask("Notion integration token", { mask: true, hint: "(hidden)" })
      const database = await ask("Notion database ID or URL", { hint: "(database ID or URL)" })
      if (localEnv) {
        writeEnvFile(root, { DOKOMADE_NOTION_TOKEN: token, DOKOMADE_NOTION_DB: database })
        ignoreEnvFile(root)
      } else {
        setSecret("DOKOMADE_NOTION_TOKEN", token)
        setSecret("DOKOMADE_NOTION_DB", database)
      }
    } else {
      const key = await ask("Google service-account JSON", { mask: true, hint: "(hidden, paste JSON)" })
      const spreadsheet = await ask("Google spreadsheet ID or URL", { hint: "(spreadsheet ID or URL)" })
      const tab = await ask("Google Sheets tab", { hint: "[log]", defaultPrompt: "log" })
      const values = { DOKOMADE_SHEETS_KEY: key, DOKOMADE_SHEETS_ID: spreadsheet, DOKOMADE_SHEETS_TAB: tab || "log" }
      if (localEnv) {
        writeEnvFile(root, values)
        ignoreEnvFile(root)
      } else {
        setSecret("DOKOMADE_SHEETS_KEY", key)
        setSecret("DOKOMADE_SHEETS_ID", spreadsheet)
        if (tab) setSecret("DOKOMADE_SHEETS_TAB", tab)
      }
    }
  } catch (error) {
    console.log(`${c.yellow}${fig.cornerBottom}${c.reset}  ${c.yellow}${c.bold}Connection failed${c.reset}\n`)
    console.error(`  ${c.yellow}${fig.step}${c.reset} ${c.bold}connect:${c.reset} ${String(error)}\n`)
    process.exitCode = 1
    return
  }

  const p = paths(root)
  config.integrations[integration] = true
  writeConfig(p, config)

  // 로컬 .env 모드에서는 GitHub Actions workflow가 읽을 Secrets가 없다.
  const changed = localEnv ? false : writeWorkflow(root, safeRelativePath(config.logDir, "docs/dokomade"))

  console.log(`${c.green}${fig.cornerBottom}${c.reset}  ${c.green}${c.bold}Connected successfully!${c.reset}\n`)
  console.log(`${c.green}${fig.tick}${c.reset} ${c.bold}${serviceTitle} integration enabled${c.reset}\n`)
  console.log(`  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}config${c.reset}       ${service} enabled in .dokomade/config.json`)
  if (localEnv) {
    console.log(`  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}secrets${c.reset}      stored in local .env with restricted permissions`)
    console.log(`  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}protection${c.reset}   .env added to .gitignore — never commit or share it`)
    console.log(
      `\n${c.yellow}${fig.bullet}${c.reset} ${c.bold}Next step:${c.reset} Run ${c.cyan}git init${c.reset}, then ${c.cyan}npx dokomade sync${c.reset} locally.\n`,
    )
  } else {
    console.log(`  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}workflow${c.reset}     ${changed ? "wrote" : "already up to date"} ${WORKFLOW_FILE}`)
    console.log(`  ${c.cyan}${fig.bullet}${c.reset} ${c.dim}secrets${c.reset}      stored in GitHub repository secrets via ${c.cyan}gh secret set${c.reset}`)
    console.log(
      `\n${c.yellow}${fig.bullet}${c.reset} ${c.bold}Next step:${c.reset} Commit and push ${c.cyan}${WORKFLOW_FILE}${c.reset} — sync runs on every push that adds log rows.\n`,
    )
  }
}
