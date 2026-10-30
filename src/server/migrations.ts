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
` }];

/** Runs inside restoreDatabase's private staging transaction, before the database is published. */
export function afterProductRestore(db: DatabaseSync): void {
  // Auth-only backups predate the workbench; normal startup will apply its migration.
  if (!db.prepare('SELECT version FROM app_migrations WHERE version=2').get()) return;
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
