/**
 * The wire contract between the `chrome-devtools` command that agents run and 司门's host beside the browser (ADR 0023).
 * The command sends its protocol number on every run; the host refuses a different one, so an old command never runs
 * against new rules. Raise the number whenever a request or response changes in a way the other side cannot read.
 */
export const SIMEN_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-simen-protocol';
/** Where the command finds the host and its token when nothing else is configured. */
export const DEFAULT_URL = 'http://127.0.0.1:3200';
export const DEFAULT_TOKEN_FILE = '/links/simen-token';
/** How long one run request may wait for a window before the command asks again. */
export const LONG_POLL_MS = 10_000;

/** Exit codes besides the official command's own: refused by the rules, host or browser unavailable, waited too long. */
export const EXIT = { refused: 2, unavailable: 3, waitedTooLong: 4 } as const;

export type RunRequest = { session?: string; cwd: string; argv: string[] };
export type RunResponse =
  | { kind: 'result'; code: number; stdout: string; stderr: string }
  | { kind: 'wait'; ahead: number; waitedMs: number; limitMs: number };
export type HostStatus = {
  protocol: number; version: string; revision?: string; official: string;
  browser: { running: boolean; version?: string; since?: string };
  windows: { limit: number; held: { session: string; pageId?: number; idleSeconds: number }[] };
  waiting: number; idleMinutes: number; waitMinutes: number;
  memoryBytes?: number;
};
