/**
 * File path -> what was worked on.
 *
 * Frontend is classified per page, not per component: five components under
 * one page are one piece of work, and the log row should say so. Backend is
 * classified per REST domain. Directories come from config.json, never
 * hardcoded here.
 */
import path from "node:path";
import type { ClassifyConfig } from "./store.js";

export const SHARED_LABEL = "common";

export const SCOPE_TOKENS = ["Frontend", "Backend", "Core", "Etc"] as const;
export type WorkScope = string;

export function normalizeScope(value: string): WorkScope {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0 || tokens.some((token) => !SCOPE_TOKENS.includes(token as (typeof SCOPE_TOKENS)[number]))) {
    return "Etc"
  }
  if (tokens.includes("Etc")) return "Etc"
  return SCOPE_TOKENS.filter((token) => token !== "Etc" && tokens.includes(token)).join(",") || "Etc"
}

const toPosix = (p: string): string => p.split(path.sep).join("/").replace(/^\.\//, "");

/** First path segment under `dir`, with any file extension stripped. */
function segmentUnder(rel: string, dir: string): string | null {
  const normalizedDir = toPosix(dir).replace(/\/+$/, "");
  if (normalizedDir === "." || normalizedDir === "") {
    const rootSegment = rel.split("/")[0];
    return rootSegment ? rootSegment.replace(/\.[^.]+$/, "") : null;
  }
  const prefix = `${normalizedDir}/`;
  if (!rel.startsWith(prefix)) return null;
  const rest = rel.slice(prefix.length);
  const seg = rest.split("/")[0];
  if (!seg) return null;
  return seg.includes(".") ? seg.replace(/\.[^.]+$/, "") : seg;
}

export function classify(relPath: string, cfg: ClassifyConfig): string {
  const rel = toPosix(relPath);

  for (const dir of cfg.frontend.sharedDirs) {
    if (segmentUnder(rel, dir)) return SHARED_LABEL;
  }
  for (const dir of cfg.frontend.pageDirs) {
    const seg = segmentUnder(rel, dir);
    if (seg) return seg;
  }
  for (const dir of cfg.backend.routeDirs) {
    const seg = segmentUnder(rel, dir);
    if (seg) return seg;
  }

  const parent = path.posix.dirname(rel);
  if (parent && parent !== "." && parent !== "/") {
    const last = parent.split("/").pop();
    if (last) return last;
  }
  return path.posix.basename(rel).replace(/\.[^.]+$/, "");
}

/** Labels for a turn, most-touched first, duplicates collapsed. */
export function classifyAll(relPaths: string[], cfg: ClassifyConfig): string[] {
  const counts = new Map<string, number>();
  for (const p of relPaths) {
    const label = classify(p, cfg);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}
