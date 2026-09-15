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

Logs land in `docs/dokomade/<github_name_lowercase_with_underscores>/<YYYY-MM-DD>.md`, next to the
`package.json` that installs dokomade. If more than one package installs it (a monorepo with both
frontend and backend set up), they land at the top level instead.

## Cursor support

Cursor Agent logging uses `beforeSubmitPrompt`, `afterFileEdit`, and `stop`.
Inline Tab completions are not logged.

Cursor log titles use changed file names. Goal is empty and Scope defaults to
`Etc`, because this integration does not inject the title request or collect
the assistant's final response. Logging makes no extra AI calls.

Automatic commit-message generation through Cursor CLI is not supported.
Use a supported, authenticated Claude Code, Codex, or Gemini CLI, or provide a
manual message with `npx dokomade commit -am "fix: ..."`.

## Optional integrations

Notion and Google Sheets sync run after `dokomade push` for your own log rows
whose status is not `push`. GitHub repositories use GitHub Actions by default;
other repositories use a local `.env` file.

```bash
npx dokomade connect notion   # stores the secrets and prepares sync
git add .github/workflows/dokomade-sync.yml && git commit -m "ci: dokomade sync"
```

For a GitHub repository, `connect` writes `.github/workflows/dokomade-sync.yml`.
**Commit and push it** - after that GitHub Actions syncs the committed logs.
`dokomade push` also syncs locally when the repository is not on GitHub.

If `.gitignore` explicitly blocks the log directory, `connect` stops and asks you
to remove that rule yourself. It never deletes an existing ignore rule.

Required secrets are `DOKOMADE_NOTION_TOKEN`, `DOKOMADE_NOTION_DB`,
`DOKOMADE_SHEETS_KEY`, and `DOKOMADE_SHEETS_ID`. Run `connect` yourself after
authenticating GitHub CLI; it sends values directly to `gh secret set`.

If the project has no GitHub repository, `connect` offers a local fallback. If
you accept, it writes shell-compatible `export` entries to `.env`, restricts
the file to your user, and adds `.env` to `.gitignore`. The local file is read
for terminal syncs, but never commit or share it. A Git repository is still
required for `commit` and `push`.

Local sync scans every date file below your own author directory. GitHub Actions
scans all checked-in author directories, keeps Notion in one database, and uses
one Google Sheets tab per author. It appends rows in date order and never
rewrites existing destination data.

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

## Step 2 - Install, then run init non-interactively

Install dokomade as a devDependency of the package it should log, then run init from inside that
package. In a monorepo that is the workspace's own `package.json` (e.g. `apps/web`), not the root.

```bash
npm i -D dokomade          # pnpm add -D dokomade / yarn add -D dokomade
npx dokomade init --<project_type>
```

Do not choose a log folder yourself - init decides it:

- init sets itself up at the repo root (nearest `.git`), wherever inside the repo you run it.
- Logs go to `docs/dokomade/` next to the one `package.json` that lists dokomade.
- Two or more packages list it, the root lists it, or a subfolder was already initialised → logs go to the top-level `docs/dokomade/`.

Fill in the type you chose:

```bash
npx dokomade init --frontend
npx dokomade init --backend
npx dokomade init --fullstack
npx dokomade init --library
```

### Workspace with separate frontend and backend repositories

If one workspace contains sibling Git repositories, install and initialize dokomade at the parent workspace root. The parent owns the session, discovers direct child repositories with Git, and `commit`/`push` asks which changed repository to use. Pass `--repo <name>` for non-interactive runs.

Child `.dokomade/` folders do not create extra sessions while the parent is open. They only apply when that child folder is opened directly. Without a parent `.dokomade/`, a parent workspace does not discover or activate child installs.

When the parent workspace is not itself a Git repository, its `docs/dokomade/` logs can still be written locally, but they cannot be included in a frontend or backend commit. Use a separate documentation repository if those logs must be versioned.

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
