#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { commit, push } from "./commands/commit.js";
import { init } from "./commands/init.js";
import { log } from "./commands/log.js";
import { retitle } from "./commands/retitle.js";
import { status } from "./commands/status.js";

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
  .action(async () => init());

program
  .command("status")
  .description("Show pending tool calls, today's log, and hook timings")
  .action(() => status());

const withCommitOptions = (cmd: Command): Command =>
  cmd
    .option("-m, --message <message>", "commit message; skips the AI entirely")
    .option("-F, --message-file <path>", "read the commit message from a file")
    .option("--orphan-title <title>", "title for the row covering unlogged changes")
    .option("--context", "print the brief for an assistant to answer, then exit")
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
  .command("log")
  .argument("<title>", "what you did")
  .description("Add a log row by hand (title only)")
  .action((title: string) => log(title));

program
  .command("retitle")
  .argument("<title>", "replacement title for the row just written")
  .description("Rewrite the last log row's title")
  .action((title: string) => retitle(title));

program.parse();

