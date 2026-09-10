# dokomade

> Automatic work logs for AI coding sessions. Records the files Claude Code, Cursor, and Codex change, then writes one row per turn to a daily Markdown log.

## Install: paste this to your AI agent

Copy the line below, paste it into Claude Code / Cursor / Codex, and it installs itself.

```text
https://github.com/noah071610/Dokomade # read this repo's README and set dokomade up in my project.
```

That's it. The agent reads the setup section at the bottom, picks the right project type, and runs init.

## At a glance

> [!IMPORTANT]
> **Normal work costs 0 tokens.** dokomade only records file changes; it never calls AI per task.

| What you do                                   |                        Extra tokens |
| --------------------------------------------- | ----------------------------------: |
| Any coding turn (1 file or 100)               |                               **0** |
| `dokomade commit` / `dokomade push` with no pending work | **0** |
| `dokomade commit` / `dokomade push` with pending work   | 1 extra AI call (~60k in / 700 out) |

Logs land in `docs/dokomade/<github_name_lowercase_with_underscores>/<YYYY-MM-DD>.md`.

---

# Agent setup instructions

Everything below is for the AI agent. Follow it top to bottom.

## Step 1 - Decide the project type

Inspect the repo and pick exactly one:

| Type        | Pick when                                                                       |
| ----------- | ------------------------------------------------------------------------------- |
| `frontend`  | Client-only web/desktop/mobile app. No server routes. (Vite/CRA/RN/Electron)    |
| `backend`   | Server APIs, services, DB routes only. No UI. (Express/Nest/FastAPI/Go)         |
| `fullstack` | UI and server routes in one repo. (Next.js, Remix, Nuxt, SvelteKit, monorepo)   |
| `library`   | npm package, SDK, CLI, plugin, VS Code/Chrome extension. Ships code, not an app |

Signals: `next.config.*`/`app/api/` → fullstack. `package.json` `"bin"` or `"exports"` with no app entry → library. Only `src/routes`, `controllers/`, `Dockerfile`, no UI deps → backend. React/Vue deps with no server dir → frontend.

## Step 2 - Run init non-interactively

```bash
npx dokomade init --<project_type>
```

Fill in the type you chose:

```bash
npx dokomade init --frontend
npx dokomade init --backend
npx dokomade init --fullstack
npx dokomade init --library
```

The type flag skips the interactive project-type and folder pickers, making these commands safe to run unattended.

One prompt can still appear: if `docs/dokomade/` already exists, init asks whether to wipe old logs. It defaults to **no** and auto-answers `no` when stdin is not a TTY.

## Step 3 - Tell the user what happened

init writes:

- `.dokomade/config.json` - project type and classify dirs
- hooks into `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json` (prompt, file edit, stop)

Then say this to the user:

1. **Restart the coding tool** so hooks load.
2. **Codex only:** run `codex` interactively once in this project and approve the hooks review at startup.
## Commands

```bash
npx dokomade status                  # pending tool calls, today's log, hook timings
npx dokomade commit                  # AI writes the message, then commit
npx dokomade push                    # AI writes the message, then push
npx dokomade commit -am "fix: ..."   # manual title; skips AI generation
```

## Token rules to respect

- Logging is hook-driven. Never call an AI just to log.
- `push` with nothing to commit is free.

## Scope: init only touches one project

`init` writes only inside the project root it resolves (nearest `.git` ancestor, else cwd).
It never writes to `~/.claude/settings.json` or any user-global config, so a project without
`init` has no dokomade hooks at all.

Global install (`npm i -g dokomade`) only puts the `dokomade` binary on PATH - it does not
apply dokomade to any project. The tradeoff: hook commands are then absolute paths into the
global `node_modules`, so uninstalling globally breaks the hooks in every project already
initialized. Prefer a devDependency plus `npx dokomade init`.
