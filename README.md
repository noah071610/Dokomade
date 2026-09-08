# dokomade

> Automatic work logs for AI coding sessions.

dokomade records the files changed by Claude Code, Cursor, and Codex, then writes one concise row per turn to a daily Markdown log.

# At a glance

> [!IMPORTANT]
> **Regular work adds 0 tokens.** dokomade only records files; it does not call AI for every task.

| Example input | Approximate additional tokens used by dokomade |
| --- | ---: |
| `"Fix the login bug"` | **0 tokens** |
| `"Update src/login.ts"` — one file changed | **0 tokens** |
| `"Fix the entire UI"` — multiple files changed | **0 tokens** |
| `/dokomade-commit` | About **400–600 tokens** — adds a commit brief to the existing agent turn |
| `dokomade commit -m "Fix login issue"` | **0 tokens** |
| `dokomade push` — no changes to commit | **0 tokens** |
| `dokomade push` — uncommitted changes + automatic AI | About **1 extra AI call** — same as terminal `commit` |

## The only exception: commit

If you run `dokomade commit` in a terminal without a message and enable automatic AI, it makes **1 extra AI call** to write the commit message. In a real Codex test, this used about **60,000 input + 700 output tokens**, including repository exploration.

To save tokens, provide the commit message yourself:

```bash
dokomade commit -m "fix: handle login error"
```

`push` also uses **0 tokens** when there are no uncommitted changes. If changes exist, it commits them first and follows the rules above.

## Quick start

Run this in your project root:

```bash
npx dokomade init
```

Restart your coding tool, then work as usual. Logs are saved to:

```text
docs/dokomade/<author>/<YYYY-MM-DD>.md
```

## Commands

```bash
npx dokomade status
npx dokomade commit
npx dokomade push
npx dokomade log "what you did"
npx dokomade retitle "better title"
```

Logging is automatic and does not make an extra AI call.

[dokomade] 토큰 사용량 한눈보기
