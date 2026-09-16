/**
 * The terminal report for `dokomade commit` / `dokomade push`.
 *
 * Summaries can carry double-width characters, so they cannot be padded into a
 * column with `padEnd`. They go last on every line instead - only ASCII of
 * known width is ever aligned.
 */

// init과 commit/push에서 같은 로고를 재사용한다.
export const ART = [
  "██████╗  ██████╗ ██╗  ██╗ ██████╗ ███╗   ███╗ █████╗ ██████╗ ███████╗",
  "██╔══██╗██╔═══██╗██║ ██╔╝██╔═══██╗████╗ ████║██╔══██╗██╔══██╗██╔════╝",
  "██║  ██║██║   ██║█████╔╝ ██║   ██║██╔████╔██║███████║██║  ██║█████╗",
  "██║  ██║██║   ██║██╔═██╗ ██║   ██║██║╚██╔╝██║██╔══██║██║  ██║██╔══╝",
  "██████╔╝╚██████╔╝██║  ██╗╚██████╔╝██║ ╚═╝ ██║██║  ██║██████╔╝███████╗",
  "╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝",
]

// ponytail: no color library. Four codes is not worth a dependency.
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s)

export const dim = (s: string): string => paint("2", s)
export const cyan = (s: string): string => paint("36", s)
export const green = (s: string): string => paint("32", s)

export interface ReportRow {
  time: string
  summary: string
}

export interface Report {
  /** Where the rows landed: the word printed against every row. */
  verb: "commit" | "push"
  /** Branch, file count, whatever belongs on the subtitle line. */
  meta: string[]
  rows: ReportRow[]
  /** Anything the user still has to know, printed under the rows. */
  notes?: string[]
}

const INDENT = "  "

export function report({ verb, meta, rows, notes = [] }: Report): void {
  const out: string[] = [""]
  for (const line of ART) out.push(INDENT + cyan(line))
  out.push("")
  if (meta.length > 0) out.push(INDENT + dim(meta.join(" · ")))

  out.push("")
  if (rows.length === 0) {
    out.push(`${INDENT}${dim("(no log rows)")}`)
  } else {
    for (const row of rows) {
      out.push(`${INDENT}${green("●")} ${dim(row.time)}  ${green(verb.padEnd(6))} ${row.summary}`)
    }
  }

  if (notes.length > 0) {
    out.push("")
    for (const note of notes) out.push(INDENT + dim(note))
  }
  out.push("")
  console.log(out.join("\n"))
}
