import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/hooks/on-prompt.ts",
    "src/hooks/on-tool.ts",
    "src/hooks/on-stop.ts",
  ],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  // Each hook must be a self-contained file: no shared chunk to resolve at
  // startup. on-tool runs on every file edit, so cold start is the budget.
  splitting: false,
});
