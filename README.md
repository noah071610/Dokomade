# dokomade

> Automatic work logs for AI coding sessions.

dokomade records the files changed by Claude Code, Cursor, and Codex, then writes one concise row per turn to a daily Markdown log.

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
