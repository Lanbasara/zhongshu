/**
 * The wire contract between the `sichen` command and Zhongshu (ADR 0022). The command sends its protocol number on every
 * request; Zhongshu refuses a different one with `protocol_mismatch`, so an old command never runs against new rules.
 * Raise the number whenever a request or response changes in a way the other side cannot read.
 */
export const SICHEN_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-sichen-protocol';
export const ZONE_HEADER = 'x-sichen-zone';
/** Where the command finds Zhongshu and its token when nothing else is configured: the instance's agent endpoint. */
export const DEFAULT_URL = 'http://127.0.0.1:3100';
export const DEFAULT_TOKEN_FILE = '/links/sichen-token';

export type Target = 'here' | 'new' | 'new_once';
export type TimelineKind = 'action' | 'event' | 'decision' | 'research';
/** A task as the command shows it: the rule in words, the next runs and where results go. */
export type SichenTask = {
  id: string; name: string; status: 'active' | 'paused' | 'ended'; prompt: string; updatedAt?: string;
  rule: string; timeZone?: string; until?: string; next: string[];
  to: string; conversationId?: string;
  lastRun?: { at: string; late: boolean; result?: string };
};
export type SichenError = { error: string; message: string; problems?: string[] };
