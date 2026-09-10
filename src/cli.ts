#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { commit, push } from "./commands/commit.js";
import { connect } from "./commands/connect.js";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { sync } from "./commands/sync.js";

const { version, description } = createRequire(import.meta.url)("../package.json") as {
  version: string;
  description: string;
};

const program = new Command()
  .name("dokomade")
  .description(description || "Log what you actually changed while vibe coding")
  .version(version);

program
  .command("init")
  .description("Install the hooks and create .dokomade/")
  .option("--frontend", "project type: client-side app")
  .option("--backend", "project type: server APIs and services")
  .option("--fullstack", "project type: frontend + backend")
  .option("--library", "project type: library, plugin, or extension")
  .action(async (options: Record<string, boolean | undefined>) => {
    const projectType = (["frontend", "backend", "fullstack", "library"] as const).find((t) => options[t]);
    return init(process.cwd(), projectType);
  });

program
  .command("status")
  .description("Show pending tool calls, today's log, and hook timings")
  .action(() => status());

const withCommitOptions = (cmd: Command): Command =>
  cmd
    .option("--manual-message <message>", "manual commit title (short alias: -am)")
    .option("--orphan-title <title>", "title for the row covering unlogged changes")
    .option("-y, --yes", "skip the confirmation prompt")
    .option("--no-ai", "never shell out to an AI CLI");

withCommitOptions(
  program
    .command("commit")
    .description("Stage everything, write the message with your own AI, commit"),
).action(async (opts) => {
  await commit(opts);
});

withCommitOptions(
  program.command("push").description("Commit any pending work, then push"),
).action((opts) => push(opts));

program
  .command("connect")
  .argument("<service>", "notion or sheets")
  .description("Store integration credentials in GitHub Actions secrets")
  .action((service: string) => connect(service));

program
  .command("sync")
  .option("--since <ref>", "git ref to compare against", "HEAD~1")
  .option("--dry-run", "list the rows that would be sent, send nothing")
  .description("Send newly pushed log rows to enabled integrations")
  .action((options: { since?: string; dryRun?: boolean }) => sync(options));

const args = process.argv.slice(2)
const manualIndex = args.indexOf("-am")
if (manualIndex !== -1) args[manualIndex] = "--manual-message"
program.parse([process.argv[0] ?? "node", process.argv[1] ?? "dokomade", ...args])
