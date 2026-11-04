import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { identifierSchema, workspaceLimit } from '../shared/workbench.ts';

export const conversationPageInput = z.object({
  beforeId: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(30),
  workspaceId: identifierSchema.optional(), archived: z.boolean().optional(),
  title: z.string().max(200).optional(), excludeWorkspaces: z.array(identifierSchema).max(workspaceLimit).optional(),
}).strict();
export type ConversationSearch = z.input<typeof conversationPageInput>;

/** Authenticated metadata search. LIMIT applies to the indexed candidates before
 * arbitrary substring/exclusion predicates, including when there are no hits.
 * No FTS tokenizer or JS case folding changes the existing SQLite semantics.
 */
export function scanConversationIds(db: DatabaseSync, input: Omit<z.output<typeof conversationPageInput>, 'beforeId'>,
  before: { createdAt: number; id: string } | null, scanLimit = 200) {
  const cursor = [before?.createdAt ?? 9223372036854775807n, before?.id ?? ''] as const;
  const match = [input.title ?? '', JSON.stringify(input.excludeWorkspaces ?? [])];
  const rows = input.workspaceId !== undefined && input.archived !== undefined
    ? db.prepare(`SELECT id,instr(lower(title),lower(?))>0 AND workspace_id NOT IN (SELECT value FROM json_each(?)) AS matches FROM (
        SELECT id,title,workspace_id FROM workbench_conversations
        WHERE workspace_id=? AND archived=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?
      )`).all(...match, input.workspaceId, Number(input.archived), ...cursor, scanLimit + 1)
    : input.workspaceId !== undefined
      ? db.prepare(`SELECT id,instr(lower(title),lower(?))>0 AND workspace_id NOT IN (SELECT value FROM json_each(?)) AS matches FROM (
          SELECT id,title,workspace_id FROM workbench_conversations
          WHERE workspace_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?
        )`).all(...match, input.workspaceId, ...cursor, scanLimit + 1)
      : input.archived !== undefined
        ? db.prepare(`SELECT id,instr(lower(title),lower(?))>0 AND workspace_id NOT IN (SELECT value FROM json_each(?)) AS matches FROM (
            SELECT id,title,workspace_id FROM workbench_conversations
            WHERE archived=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?
          )`).all(...match, Number(input.archived), ...cursor, scanLimit + 1)
        : db.prepare(`SELECT id,instr(lower(title),lower(?))>0 AND workspace_id NOT IN (SELECT value FROM json_each(?)) AS matches FROM (
            SELECT id,title,workspace_id FROM workbench_conversations
            WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?
          )`).all(...match, ...cursor, scanLimit + 1);
  const ids: string[] = []; let scanned = 0;
  for (const row of rows.slice(0, scanLimit)) {
    scanned++;
    if (row.matches) ids.push(String(row.id));
    if (ids.length === input.limit) break;
  }
  const beforeId = rows.length > scanned ? String(rows[scanned - 1]!.id) : null;
  return { ids, beforeId, scanned, scanLimited: beforeId !== null && ids.length < input.limit };
}
