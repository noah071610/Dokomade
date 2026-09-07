/**
 * Normalized event shape. Each AI coding tool ships its own hook payload;
 * adapters flatten those into these three events so `src/hooks/*` and
 * `src/core/*` never learn a vendor's field names.
 */

export interface PromptEvent {
  kind: "prompt";
  sessionId: string;
  cwd: string;
  promptText: string;
  transcriptPath?: string;
}

export interface ToolEvent {
  kind: "tool";
  sessionId: string;
  cwd: string;
  toolName: string;
  /** Absolute or cwd-relative paths the tool wrote to. Empty = not a file edit. */
  filePaths: string[];
}

export interface StopEvent {
  kind: "stop";
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
}

export type DokomadeEvent = PromptEvent | ToolEvent | StopEvent;

export interface Adapter {
  name: string;
  /** Returns null when the payload is not an event we track. */
  parse(raw: unknown): DokomadeEvent | null;
}
