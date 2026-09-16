# dokomade

> Automatic work logs for AI coding sessions. Records the files Claude Code, Cursor, and Codex change, then writes one row for each turn that changed files to a daily Markdown log.

## Install: paste this to your AI agent

Copy the line below, paste it into Claude Code / Cursor / Codex, and it installs itself.

```text
https://github.com/noah071610/Dokomade # read this repo's README and set dokomade up in my project.
```

The agent reads **Agent setup instructions** at the bottom, picks the project type, installs the package, and runs init.
init prints the activation steps for your coding tool; installation does not approve hook trust.

Requirements: Node.js 18+ and Git. GitHub CLI (`gh`) is needed only for `connect` on a GitHub repository.

## Activate hooks after init

Open your coding tool at the project root init printed (`Project root: ...`). Claude Code reads
`.claude/settings.json` only from the folder you start it in, so a session started in a subfolder
does not load the hooks.

- **Codex:** from the initialized project root, run `codex` in your own terminal.
  Accept project trust if prompted, then type `/hooks` inside Codex. Find the hooks
  from `.codex/hooks.json`, review the dokomade commands pointing to `hooks/on-*.js`,
  and trust them. If hooks need review, Codex also prints a startup warning pointing to `/hooks`.
  Untrusted hooks are skipped; changed hook definitions need another review.
- **Claude Code:** start (or restart) Claude Code from the project root and accept workspace
  trust if prompted. Use `/hooks` to verify the dokomade hooks from `.claude/settings.json`.
  Hooks in a trusted workspace normally reload automatically.
- **Cursor:** open the project root as the workspace and trust it if prompted.
  `.cursor/hooks.json` reloads automatically. Check Customize > Hooks and the Hooks
  output channel; restart Cursor if the hooks are missing.

### Can the setup agent approve everything automatically?

There is no shared, persistent auto-approval step across all three tools. The
agent can install the hook definitions, but it must leave interactive trust
decisions to you rather than editing trust records or disabling safety checks.

Codex offers `--dangerously-bypass-hook-trust` for one-off automation that already
vets its hook sources. It bypasses trust only for that invocation, does not save
approval for your later sessions, and is never added by dokomade. Claude Code
`claude -p` and SDK sessions use settings-file hooks without showing the workspace
trust dialog, so they do not trust the folder for later interactive use (dokomade
also ignores `claude -p` runs, so they add no log rows). Cursor runs project hooks
in any trusted workspace, with no separate per-hook approval step.

See the official [Codex hooks](https://developers.openai.com/codex/hooks),
[Claude Code workspace trust](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder),
and [Cursor hooks](https://cursor.com/docs/hooks) documentation.

## At a glance

> [!IMPORTANT]
> **No extra AI calls while you work.** Hooks only record file changes; dokomade never calls a model per turn.

| What you do                                              | Extra AI calls / tokens                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Coding turn in Cursor (1 file or 100)                    | **0**                                                                                      |
| Coding turn in Claude Code or Codex                      | **0 calls.** A short title request (a few hundred tokens) is added to each prompt, and the assistant ends its reply with three tagged lines |
| `dokomade commit` / `dokomade push` with no pending work | **0**                                                                                      |
| `dokomade commit` / `dokomade push` with pending work    | 1 AI call (~60k in / 700 out) when an AI CLI is configured; **0** with `-am` or `--no-ai`   |
| A git command inside `commit` / `push` fails             | 1 short AI call to summarize the error when an AI CLI is configured (skip with `--no-ai`)  |

Logs land in `docs/dokomade/<author>/<YYYY-MM-DD>.md`, next to the `package.json` that installs
dokomade. `<author>` is your `git config user.name`, lowercased with spaces replaced by `_` (falling
back to `GIT_AUTHOR_NAME`, then your OS user name). If more than one package installs it (a monorepo
with both frontend and backend set up), logs land at the top level instead.

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

Send log rows to Notion and/or Google Sheets. Run `connect` yourself in a terminal: it asks for
secrets interactively.

```bash
npx dokomade connect notion   # or: npx dokomade connect sheets

# GitHub repositories only: commit and push the generated workflow
git add .github/workflows/dokomade-sync.yml
git commit -m "ci: dokomade sync" && git push
```

**GitHub repositories** (`origin` points at github.com): install GitHub CLI and run `gh auth login`
first. `connect` sends the values directly to `gh secret set` and writes
`.github/workflows/dokomade-sync.yml`. **Commit and push it.** The workflow runs on every push that
changes the log directory, runs `sync --all-authors` over all checked-in author directories, keeps
Notion in one database, and uses one Google Sheets tab per author.

**Other repositories:** `connect` offers a local fallback and writes no workflow. If you accept, it
writes shell-compatible `export` entries to `.env`, restricts the file to your user, and adds `.env`
to `.gitignore`. After that, `dokomade push` syncs your own rows from the terminal, and
`npx dokomade sync` sends them manually. Both need a Git repository - run `git init` first if the
project has none. Never commit or share `.env`. In a workspace of several child repositories, sync
does not run after push.

Secrets are `DOKOMADE_NOTION_TOKEN` and `DOKOMADE_NOTION_DB` for Notion, and `DOKOMADE_SHEETS_KEY`
(service-account JSON) and `DOKOMADE_SHEETS_ID` for Google Sheets, plus the optional tab-name prefix
`DOKOMADE_SHEETS_TAB`. Before asking for them, `connect` prints the required Notion database
properties or the Google service-account setup.

Sync sends rows whose status is not `push`, appends each author's rows in date order, and never
rewrites existing destination data. Only `dokomade push` marks rows `push`, and the GitHub workflow
cannot mark them, so a row can be sent more than once:

- Use `dokomade push` instead of plain `git push`. Rows that stay at `stage` or `commit` are sent
  again by later syncs.
- On a team, a teammate's rows stay at `stage` or `commit` in the repository until that teammate
  runs `dokomade push` and commits again, so other people's pushes can send those rows again.

If `.gitignore` blocks the log directory on a GitHub repository, `connect` stops and asks you to
remove that rule yourself. It never deletes an existing ignore rule.

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
Always install first: a bare `npx dokomade init` runs a temporary copy, and the hooks would point
into npx's cache.

```bash
npm i -D dokomade          # pnpm add -D dokomade / yarn add -D dokomade
npx dokomade init --<project_type>
```

Fill in the type you chose:

```bash
npx dokomade init --frontend
npx dokomade init --backend
npx dokomade init --fullstack
npx dokomade init --library
```

Do not choose the project root or log folder yourself - init decides them:

- Project root: the nearest ancestor with `.dokomade/` or `.git`, wherever inside the repo you run it. Without either, the npm/pnpm workspace root, else the current directory. `.dokomade/` and the hook files go there.
- Logs go to `docs/dokomade/` next to the one `package.json` that lists dokomade (searched up to 4 levels below the root).
- Two or more packages list it, the root lists it, none does, or a subfolder was already initialised → logs go to the top-level `docs/dokomade/`.

The type flag skips the interactive project-type and folder pickers. Two yes/no prompts remain, and
both take their defaults automatically when stdin is not a TTY (the usual case for an agent's shell):

- `Delete existing logs in docs/dokomade/ and start over?` - only when the log folder exists; default **no**.
- `Skip API integrations?` - default **yes**. Integrations are set up later with `connect`.

Re-running init is safe: it replaces its own hook entries instead of adding copies and keeps the
existing integration and commit-AI settings. Re-run it after upgrading dokomade or moving the project,
because hook commands contain the package's resolved path (with pnpm, that path includes the version).

### Workspace with separate frontend and backend repositories

If one workspace contains sibling Git repositories, install and initialize dokomade at the parent workspace root. The parent owns the session, discovers direct child repositories with Git, and `commit`/`push` asks which changed repository to use. Pass `--repo <name>` for non-interactive runs.

Child `.dokomade/` folders do not create extra sessions while the parent is open. They only apply when that child folder is opened directly. Without a parent `.dokomade/`, a parent workspace does not discover or activate child installs.

When the parent workspace is not itself a Git repository, its `docs/dokomade/` logs can still be written locally, but they cannot be included in a frontend or backend commit. Use a separate documentation repository if those logs must be versioned.

## Step 3 - Tell the user what happened

init writes, at the project root:

- `.dokomade/config.json` - project type, classify dirs, integration and commit settings
- hooks into `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json` (prompt, file edit, stop)
- `.gitignore` entries: `.claude`, `.codex`, `.cursor`, `.env`, and the `.dokomade/` runtime files

Because `.claude`, `.codex`, and `.cursor` are ignored, hook files are not shared through Git: each
teammate installs dependencies and runs `npx dokomade init --<project_type>` themselves. If the project
already commits files under those folders, tell the user that new files there will now be ignored.

Relay the applicable steps from **Activate hooks after init** to the user, even
when init ran non-interactively. Tell them to open the tool at the project root init printed.
For Codex, explicitly mention `codex` → `/hooks` → review and trust the dokomade commands
from `.codex/hooks.json`.

Do not claim hooks are approved or logging is active just because init succeeded.
Do not edit user-global trust records, launch a nested AI session to approve
hooks, or automatically add trust-bypass flags. The user's next interactive
session must handle any required trust prompt.

Do not run `connect`, `commit`, or `push` unless the user asks. `connect` needs secrets that the
user types in their own terminal.

## Commands

```bash
npx dokomade status                  # pending tool calls, today's log, hook timings
npx dokomade commit                  # stage everything (git add -A), AI writes the message, commit
npx dokomade push                    # commit pending work first, then push
npx dokomade commit -am "fix: ..."   # manual message; skips AI generation
npx dokomade connect notion          # or sheets; interactive, run it yourself
npx dokomade sync --dry-run          # list the rows a sync would send, send nothing
npx dokomade sync --all-authors      # send every checked-in author's rows (the GitHub workflow runs this)
npx dokomade remove                  # strip the hooks and .dokomade/ (see Uninstall)
```

- `commit` and `push` accept `--repo <name>` (multi-repository workspace), `-y` (skip the preview
  confirmation), `--no-ai` (never run an AI CLI), and `--orphan-title <title>` (title for the row
  covering changes that have no log row).
- `-am` is dokomade's manual-message flag, not Git's `-a -m`. Everything is still staged.
- Messages come from your own `claude`, `codex`, or `gemini` CLI. The first `commit` without `-am`
  asks which one to use and saves the answer as `commit.ai` in `.dokomade/config.json`. Without a TTY
  it picks the first CLI found on PATH and commits without a preview, so agents should pass
  `-am "<message>"`.
- The message follows `commit-convention.md` at the project root when present, else Conventional Commits.
- `commit` refuses to continue when files that look like secrets (`.env`, `*.pem`, `*.key`,
  `id_rsa`, `credentials.json`, ...) would be staged.

## Token rules to respect

- Logging is hook-driven. Never call an AI just to log.
- `push` with nothing to commit is free.

## Scope: init only touches one project

`init` writes only inside the project root it resolves (see Step 2): `.dokomade/`, the three hook
files, `.gitignore`, and `.github/workflows/dokomade-sync.yml` when a GitHub repository has an
integration enabled. It never writes to `~/.claude/settings.json` or any user-global config, so a
project without `init` has no dokomade hooks at all.

Global install (`npm i -g dokomade`) only puts the `dokomade` binary on PATH - it does not
apply dokomade to any project. The tradeoff: hook commands are then absolute paths into the
global `node_modules`, so uninstalling globally breaks the hooks in every project already
initialized. Prefer a devDependency plus `npx dokomade init`.

## Uninstall

```bash
npx dokomade remove          # add --logs to delete the log directory too
npm rm dokomade
```

`remove` strips the dokomade hook entries from `.claude/settings.json`, `.codex/hooks.json`, and
`.cursor/hooks.json` - leaving any hooks you added yourself in place - deletes `.dokomade/`, and
deletes `.github/workflows/dokomade-sync.yml` when it is the generated one. Run it **before**
`npm rm dokomade`, while the binary still exists, then restart your coding tool so the removed hooks
stop firing.

Two things are left on purpose: your logs in `docs/dokomade/` (pass `--logs` to delete them) and the
`.gitignore` block, which includes the `.env` rule. Delete any `DOKOMADE_*` repository secrets or
`.env` entries yourself.
