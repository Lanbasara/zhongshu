import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './database.ts';

// Authentication owns schema v1. Additional product migrations stay in one ordered list.
export const productMigrations: Migration[] = [{ version: 2, sql: `
  CREATE TABLE workbench_conversations (
    id TEXT PRIMARY KEY,
    harness_id TEXT NOT NULL CHECK (harness_id IN ('codex', 'dsh')),
    workspace_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    creation_digest TEXT NOT NULL,
    binding_json TEXT,
    readiness TEXT NOT NULL CHECK (readiness IN ('preparing', 'ready', 'blocked')),
    state_json TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    history_loaded INTEGER NOT NULL DEFAULT 0 CHECK (history_loaded IN (0, 1)),
    native_older_cursor TEXT,
    native_older_before_item_id TEXT
  ) STRICT;
  CREATE INDEX workbench_conversations_created ON workbench_conversations(created_at, id);
  CREATE TABLE workbench_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    item_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE workbench_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('message', 'stop')),
    payload_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'accepted', 'unknown', 'rejected')),
    run_id TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX workbench_operations_status ON workbench_operations(status, sequence);
  CREATE INDEX workbench_operations_conversation ON workbench_operations(conversation_id, sequence);
  CREATE INDEX workbench_operations_conversation_status ON workbench_operations(conversation_id, status, sequence);
  CREATE TABLE workbench_items (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'notice')),
    text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 1048576),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    run_id TEXT,
    operation_id TEXT,
    PRIMARY KEY (conversation_id, id),
    UNIQUE (conversation_id, position)
  ) STRICT;
  CREATE INDEX workbench_items_operation ON workbench_items(conversation_id, operation_id, kind, run_id);
  CREATE TABLE workbench_live_items (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'notice')),
    text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 1048576),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    run_id TEXT,
    operation_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, id)
  ) STRICT;
  CREATE INDEX workbench_live_items_operation ON workbench_live_items(conversation_id, operation_id, kind, run_id);
  CREATE INDEX workbench_live_items_updated ON workbench_live_items(conversation_id, updated_at, id);
` }, { version: 3, sql: `
  ALTER TABLE workbench_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE workbench_live_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE workbench_resources (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id,digest)
  ) STRICT;
  CREATE TABLE workbench_resource_refs (
    resource_id TEXT NOT NULL REFERENCES workbench_resources(id),
    owner_id TEXT NOT NULL,
    PRIMARY KEY(resource_id,owner_id)
  ) STRICT;
` }, { version: 4, sql: `
  ALTER TABLE workbench_conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
  CREATE INDEX workbench_conversations_workspace_page ON workbench_conversations(workspace_id, archived, created_at, id);
  CREATE INDEX workbench_conversations_archive_page ON workbench_conversations(archived, created_at, id);
` }, { version: 5, sql: `
  CREATE TABLE workbench_workspaces (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    directory TEXT NOT NULL,
    identity TEXT NOT NULL,
    root_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))
  ) STRICT;
  CREATE INDEX workbench_workspaces_directory ON workbench_workspaces(directory);
` }, { version: 6, sql: `
  CREATE TABLE workbench_queues (
    conversation_id TEXT PRIMARY KEY REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    after_run_id TEXT,
    pause TEXT CHECK (pause IN ('stopped', 'failed', 'rejected', 'missed', 'restored')),
    version INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE workbench_queue_entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES workbench_queues(conversation_id) ON DELETE CASCADE,
    content_json TEXT,
    admission_digest TEXT NOT NULL,
    operation_id TEXT REFERENCES workbench_operations(id),
    held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX workbench_queue_entries_active ON workbench_queue_entries(conversation_id, sequence) WHERE content_json IS NOT NULL;
  CREATE UNIQUE INDEX workbench_queue_entries_operation ON workbench_queue_entries(operation_id) WHERE operation_id IS NOT NULL;
` }, { version: 7, sql: `
  CREATE TABLE workbench_turn_files (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (conversation_id, run_id, path)
  ) STRICT, WITHOUT ROWID;
` }, { version: 8, sql: `
  CREATE TABLE plugin_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    harness TEXT NOT NULL CHECK (harness IN ('codex', 'dsh')),
    plugin_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('install', 'enable', 'disable', 'remove')),
    status TEXT NOT NULL CHECK (status IN ('applying', 'unknown', 'applied', 'restart-required', 'failed'))
  ) STRICT;
  CREATE INDEX plugin_operations_target ON plugin_operations(harness, plugin_id, sequence);
  CREATE UNIQUE INDEX plugin_operations_in_flight ON plugin_operations(harness)
    WHERE status IN ('applying', 'unknown', 'restart-required');
` }, { version: 9, sql: `
  ALTER TABLE plugin_operations ADD COLUMN version TEXT;
` }, { version: 10, sql: `
  ALTER TABLE workbench_conversations ADD COLUMN usage_json TEXT;
  ALTER TABLE workbench_queue_entries ADD COLUMN skill_unavailable INTEGER NOT NULL DEFAULT 0 CHECK (skill_unavailable IN (0, 1));
` }, { version: 11, sql: `
  CREATE TABLE workbench_items_with_unknown (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'notice')),
    text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 1048576),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'unknown')),
    run_id TEXT,
    operation_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (conversation_id, id),
    UNIQUE (conversation_id, position)
  ) STRICT;
  INSERT INTO workbench_items_with_unknown SELECT * FROM workbench_items;
  DROP TABLE workbench_items;
  ALTER TABLE workbench_items_with_unknown RENAME TO workbench_items;
  CREATE INDEX workbench_items_operation ON workbench_items(conversation_id, operation_id, kind, run_id);
  CREATE TABLE workbench_live_items_with_unknown (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'notice')),
    text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 1048576),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'unknown')),
    run_id TEXT,
    operation_id TEXT,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (conversation_id, id)
  ) STRICT;
  INSERT INTO workbench_live_items_with_unknown SELECT * FROM workbench_live_items;
  DROP TABLE workbench_live_items;
  ALTER TABLE workbench_live_items_with_unknown RENAME TO workbench_live_items;
  CREATE INDEX workbench_live_items_operation ON workbench_live_items(conversation_id, operation_id, kind, run_id);
  CREATE INDEX workbench_live_items_updated ON workbench_live_items(conversation_id, updated_at, id);
` }, { version: 12, sql: `
  CREATE TABLE workbench_draft_preparations (
    workspace_id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    preparation_id TEXT NOT NULL UNIQUE,
    native_id TEXT NOT NULL UNIQUE,
    claimed_by TEXT
  ) STRICT;
  ALTER TABLE workbench_conversations ADD COLUMN native_preparation_id TEXT;
` }, { version: 13, sql: `
  ALTER TABLE workbench_conversations ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
  UPDATE workbench_conversations SET last_activity_at = COALESCE(
    (SELECT MAX(created_at) FROM workbench_operations WHERE conversation_id=workbench_conversations.id AND type='message' AND status='accepted'), created_at);
  CREATE INDEX workbench_conversations_activity ON workbench_conversations(last_activity_at,id);
  CREATE INDEX workbench_conversations_workspace_activity ON workbench_conversations(workspace_id,archived,last_activity_at,id);
  CREATE INDEX workbench_conversations_archive_activity ON workbench_conversations(archived,last_activity_at,id);
` }, { version: 14, sql: `
  CREATE TABLE workbench_deletions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending','native_done','failed','completed')),
    reason TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE workbench_changes_independent (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    item_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO workbench_changes_independent SELECT * FROM workbench_changes;
  DROP TABLE workbench_changes;
  ALTER TABLE workbench_changes_independent RENAME TO workbench_changes;
` }, { version: 15, sql: `
  ALTER TABLE workbench_conversations ADD COLUMN subagents_json TEXT;
  CREATE TABLE workbench_subagent_stops (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','dispatching','accepted','unknown','rejected')),
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX workbench_subagent_stops_agent ON workbench_subagent_stops(conversation_id, agent_id, created_at);
  CREATE INDEX workbench_subagent_stops_status ON workbench_subagent_stops(status, conversation_id);
` }, { version: 16, sql: `
  -- ADR 0014: history bodies live only in the native Harness. Remove the retired projection.
  DROP TABLE IF EXISTS workbench_live_items;
  DROP TABLE IF EXISTS workbench_items;
` }, { version: 17, sql: `
  -- Unread results shared by every signed-in device. seen_key is the last attention key a reader saw;
  -- seen_result_key the last one that was not "unknown", so a 待核实 episode that resolves back to an
  -- already seen result does not resurface as unread.
  ALTER TABLE workbench_conversations ADD COLUMN seen_key TEXT;
  ALTER TABLE workbench_conversations ADD COLUMN seen_result_key TEXT;
  -- Results that existed before the marker count as seen.
  UPDATE workbench_conversations SET
    seen_result_key = json_extract(state_json,'$.terminalStatus') || ':' || json_extract(state_json,'$.terminalRunId'),
    seen_key = CASE WHEN json_extract(state_json,'$.status') = 'unknown'
      THEN 'unknown:' || COALESCE(json_extract(state_json,'$.runId'), json_extract(state_json,'$.terminalRunId'), '')
      ELSE json_extract(state_json,'$.terminalStatus') || ':' || json_extract(state_json,'$.terminalRunId') END;
` }, { version: 18, sql: `
  -- ADR 0016: answers to native questions and approvals are operations with stable identities. The
  -- request itself stays native; answer_json holds the submitted answer only until it settles.
  CREATE TABLE workbench_request_answers (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','dispatching','accepted','unknown','rejected')),
    reason TEXT,
    summary TEXT NOT NULL,
    answer_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX workbench_request_answers_request ON workbench_request_answers(conversation_id, request_id, created_at);
  CREATE INDEX workbench_request_answers_status ON workbench_request_answers(status, conversation_id);
` }];

/** Runs inside restoreDatabase's private staging transaction, before the database is published. */
export function afterProductRestore(db: DatabaseSync): void {
  // Auth-only backups predate the workbench; normal startup will apply its migration.
  if (!db.prepare('SELECT version FROM app_migrations WHERE version=2').get()) return;
  if (db.prepare('SELECT version FROM app_migrations WHERE version=6').get())
    db.exec("UPDATE workbench_queues SET pause='restored',version=version+1 WHERE EXISTS (SELECT 1 FROM workbench_queue_entries WHERE conversation_id=workbench_queues.conversation_id AND content_json IS NOT NULL)");
  const conversations = db.prepare("SELECT DISTINCT conversation_id FROM workbench_operations WHERE status IN ('queued','dispatching') LIMIT 10000").all();
  const at = Date.now();
  db.prepare("UPDATE workbench_operations SET status='unknown',reason='database_restored_requires_reconciliation',updated_at=? WHERE status IN ('queued','dispatching')").run(at);
  const state = JSON.stringify({ status: 'unknown', pendingInputs: 0, configurationVerified: false, reason: 'database_restored_requires_reconciliation' });
  const update = db.prepare('UPDATE workbench_conversations SET state_json=? WHERE id=?');
  const event = db.prepare('INSERT INTO workbench_changes(conversation_id,created_at) VALUES(?,?)');
  for (const conversation of conversations) {
    const id = String(conversation.conversation_id);
    update.run(state, id); event.run(id, at);
  }
  if (conversations.length) db.exec('DELETE FROM workbench_changes WHERE sequence <= (SELECT sequence FROM workbench_changes ORDER BY sequence DESC LIMIT 1 OFFSET 2000)');
}
