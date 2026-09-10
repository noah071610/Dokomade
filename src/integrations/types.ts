import type { SyncRow } from "../core/markdown.js"

export interface SyncResult {
  service: "notion" | "sheets"
  sent: number
  failed: number
  errors: string[]
}

export type SyncFn = (rows: SyncRow[]) => Promise<SyncResult>
