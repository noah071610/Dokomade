import fs from "node:fs"
import path from "node:path"

export interface NotionEnv {
  token: string
  database: string
}

export interface SheetsEnv {
  key: string
  spreadsheet: string
  tab: string
}

const ENV_FILE = ".env"

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function parseValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'")
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1")
  }
  return trimmed
}

/** Load local shell-style secrets without overriding explicitly exported values. */
export function loadEnvFile(root: string): void {
  let source: string
  try {
    source = fs.readFileSync(path.join(root, ENV_FILE), "utf8")
  } catch {
    return
  }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match?.[1] || match[2] === undefined || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = parseValue(match[2])
  }
}

/** Merge secrets into .env while preserving unrelated settings and comments. */
export function writeEnvFile(root: string, values: Record<string, string>): void {
  const file = path.join(root, ENV_FILE)
  let lines: string[]
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
  } catch {
    lines = []
  }

  for (const [name, value] of Object.entries(values)) {
    const assignment = `export ${name}=${shellQuote(value)}`
    const index = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))
    if (index === -1) lines.push(assignment)
    else lines[index] = assignment
  }

  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Keep the local secret file out of future commits. */
export function ignoreEnvFile(root: string): void {
  const file = path.join(root, ".gitignore")
  let source = ""
  try {
    source = fs.readFileSync(file, "utf8")
  } catch {
    // 파일이 없으면 아래에서 생성한다.
  }
  if (source.split(/\r?\n/).some((line) => line.trim() === ENV_FILE)) return
  const prefix = source && !source.endsWith("\n") ? "\n" : ""
  fs.writeFileSync(file, `${source}${prefix}\n# local dokomade secrets\n${ENV_FILE}\n`)
}

export function notionEnv(env: NodeJS.ProcessEnv = process.env): NotionEnv | null {
  const token = env.DOKOMADE_NOTION_TOKEN?.trim()
  const database = env.DOKOMADE_NOTION_DB?.trim()
  return token && database ? { token, database } : null
}

export function sheetsEnv(env: NodeJS.ProcessEnv = process.env): SheetsEnv | null {
  const key = env.DOKOMADE_SHEETS_KEY?.trim()
  const spreadsheet = env.DOKOMADE_SHEETS_ID?.trim()
  if (!key || !spreadsheet) return null
  return { key, spreadsheet, tab: env.DOKOMADE_SHEETS_TAB?.trim() || "log" }
}
