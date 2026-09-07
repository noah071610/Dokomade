/**
 * Hook entry plumbing. Builtins only - see the dependency rule in
 * src/hooks/README-less note: this directory is on the hot path.
 */
import fs from "node:fs";

/** Reads the whole hook payload off stdin. Sync: there is nothing to overlap. */
export function readPayload(): unknown {
  if (process.stdin.isTTY) return null;
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}
