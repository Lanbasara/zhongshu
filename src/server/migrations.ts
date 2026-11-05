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
  CREATE TABLE workbench_archive_jobs (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('latest','backfill')),
    binding_id TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    cursor TEXT,
    anchor_id TEXT,
    pages INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
    next_at INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER,
    error TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id,kind)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX workbench_archive_due ON workbench_archive_jobs(complete,next_at,conversation_id,kind);
  INSERT INTO workbench_archive_jobs(conversation_id,kind,binding_id)
    SELECT id,'latest',json_extract(binding_json,'$.id') FROM workbench_conversations WHERE binding_json IS NOT NULL;
  INSERT INTO workbench_archive_jobs(conversation_id,kind,binding_id)
    SELECT id,'backfill',json_extract(binding_json,'$.id') FROM workbench_conversations WHERE binding_json IS NOT NULL;
  CREATE TABLE workbench_archive_scan_items (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (conversation_id,kind,id),
    FOREIGN KEY (conversation_id,kind) REFERENCES workbench_archive_jobs(conversation_id,kind) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE workbench_archive_scan_cursors (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY (conversation_id,kind,digest),
    FOREIGN KEY (conversation_id,kind) REFERENCES workbench_archive_jobs(conversation_id,kind) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
` }, { version: 12, sql: `
  CREATE TABLE workbench_bodies (
    version TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL CHECK (bytes>=0),
    chunks INTEGER NOT NULL CHECK (chunks>=0),
    complete INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0,1))
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE workbench_body_chunks (
    version TEXT NOT NULL REFERENCES workbench_bodies(version) ON DELETE CASCADE,
    part INTEGER NOT NULL CHECK (part>=0),
    data BLOB NOT NULL CHECK (length(data)<=65536),
    PRIMARY KEY(version,part)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE workbench_body_refs (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('text','input','output')),
    version TEXT NOT NULL REFERENCES workbench_bodies(version),
    PRIMARY KEY(conversation_id,item_id,field,version)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE workbench_body_stages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('text','input','output')),
    version TEXT NOT NULL REFERENCES workbench_bodies(version),
    next_offset INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id,item_id,field,version)
  ) STRICT;
` }, { version: 13, sql: `
  CREATE INDEX workbench_workspaces_page ON workbench_workspaces(removed,pinned DESC,label COLLATE NOCASE,id);
  CREATE INDEX plugin_operations_latest ON plugin_operations(harness,sequence DESC);
  CREATE TABLE workbench_workspace_generation (id INTEGER PRIMARY KEY CHECK (id=1),generation INTEGER NOT NULL) STRICT;
  INSERT INTO workbench_workspace_generation VALUES(1,0);
  CREATE TRIGGER workbench_workspace_insert AFTER INSERT ON workbench_workspaces BEGIN
    UPDATE workbench_workspace_generation SET generation=generation+1 WHERE id=1;
  END;
  CREATE TRIGGER workbench_workspace_update AFTER UPDATE ON workbench_workspaces BEGIN
    UPDATE workbench_workspace_generation SET generation=generation+1 WHERE id=1;
  END;
  CREATE TRIGGER workbench_workspace_delete AFTER DELETE ON workbench_workspaces BEGIN
    UPDATE workbench_workspace_generation SET generation=generation+1 WHERE id=1;
  END;
` }, { version: 14, sql: `
  ALTER TABLE workbench_items ADD COLUMN alternate_position INTEGER;
  CREATE UNIQUE INDEX workbench_items_alternate ON workbench_items(conversation_id,alternate_position) WHERE alternate_position IS NOT NULL;
  CREATE TABLE workbench_history_order (
    conversation_id TEXT PRIMARY KEY REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
    generation INTEGER NOT NULL DEFAULT 0,
    phase TEXT CHECK(phase IN ('clear','build')),
    after_id TEXT,
    after_position INTEGER,
    next_position INTEGER NOT NULL DEFAULT 0
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX workbench_history_rebuild ON workbench_history_order(conversation_id) WHERE phase IS NOT NULL;
` }, { version: 15, sql: `
CREATE TABLE execution_groups (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  gate_json TEXT NOT NULL
) STRICT;
CREATE TABLE execution_scopes (
  workspace_id TEXT NOT NULL REFERENCES workbench_workspaces(id),
  group_id TEXT NOT NULL REFERENCES execution_groups(id),
  directory TEXT NOT NULL,
  directory_identity TEXT NOT NULL,
  PRIMARY KEY(workspace_id,group_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX execution_scopes_group ON execution_scopes(group_id,workspace_id);
CREATE INDEX execution_scopes_directory ON execution_scopes(directory,group_id);
CREATE TABLE execution_conflicts (
  left_group TEXT NOT NULL REFERENCES execution_groups(id),
  right_group TEXT NOT NULL REFERENCES execution_groups(id),
  PRIMARY KEY(left_group,right_group)
) STRICT, WITHOUT ROWID;
CREATE TABLE execution_windows (
  id TEXT PRIMARY KEY,
  groups_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE execution_freezes (
  window_id TEXT NOT NULL REFERENCES execution_windows(id),
  group_id TEXT NOT NULL REFERENCES execution_groups(id),
  frozen_set_id TEXT NOT NULL UNIQUE,
  through_sequence INTEGER NOT NULL,
  PRIMARY KEY(window_id,group_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE execution_admissions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('operation','queue','native')),
  source_key TEXT NOT NULL,
  conversation_id TEXT REFERENCES workbench_conversations(id),
  queue_id TEXT REFERENCES workbench_queue_entries(id),
  workspace_id TEXT NOT NULL REFERENCES workbench_workspaces(id),
  directory_identity TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('queued','receipt-unknown','running','waiting','native-associated','settled')),
  current_operation TEXT REFERENCES workbench_operations(id),
  terminal_proof TEXT,
  UNIQUE(source,source_key)
) STRICT;
CREATE INDEX execution_admission_conversation ON execution_admissions(conversation_id,sequence,id);
CREATE TABLE execution_members (
  admission_id TEXT NOT NULL REFERENCES execution_admissions(id),
  group_id TEXT NOT NULL REFERENCES execution_groups(id),
  PRIMARY KEY(admission_id,group_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX execution_members_group ON execution_members(group_id,admission_id);
CREATE TABLE execution_pending (
  group_id TEXT NOT NULL REFERENCES execution_groups(id),
  sequence INTEGER NOT NULL,
  admission_id TEXT NOT NULL REFERENCES execution_admissions(id),
  PRIMARY KEY(group_id,sequence,admission_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE execution_attempts (
  operation_id TEXT PRIMARY KEY REFERENCES workbench_operations(id),
  admission_id TEXT NOT NULL REFERENCES execution_admissions(id),
  content_digest TEXT NOT NULL,
  dispatch_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','receipt-unknown','accepted','rejected'))
) STRICT;
CREATE INDEX execution_attempt_admission ON execution_attempts(admission_id,operation_id);
CREATE TABLE execution_saves (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES execution_windows(id),
  input_digest TEXT NOT NULL,
  permit_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','committed','rejected')),
  proof TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX execution_saves_pending ON execution_saves(window_id,id) WHERE outcome='pending';
CREATE TABLE execution_baselines (
  group_id TEXT PRIMARY KEY REFERENCES execution_groups(id),
  through_sequence INTEGER NOT NULL,
  after_sequence INTEGER,
  after_id TEXT,
  proof TEXT,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
) STRICT;
CREATE TABLE execution_baseline_sources (
  group_id TEXT NOT NULL REFERENCES execution_groups(id),
  source TEXT NOT NULL CHECK(source IN ('operations','queues')),
  through_sequence INTEGER NOT NULL,
  after_sequence INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  PRIMARY KEY(group_id,source)
) STRICT, WITHOUT ROWID;
` }, { version: 16, sql: `
  CREATE TABLE workbench_body_refs_v16 (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('text','input','output','references')),
    version TEXT NOT NULL REFERENCES workbench_bodies(version),
    PRIMARY KEY(conversation_id,item_id,field,version)
  ) STRICT, WITHOUT ROWID;
  INSERT INTO workbench_body_refs_v16 SELECT * FROM workbench_body_refs;
  DROP TABLE workbench_body_refs;
  ALTER TABLE workbench_body_refs_v16 RENAME TO workbench_body_refs;
  CREATE TABLE workbench_body_stages_v16 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('text','input','output','references')),
    version TEXT NOT NULL REFERENCES workbench_bodies(version),
    next_offset INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id,item_id,field,version)
  ) STRICT;
  INSERT INTO workbench_body_stages_v16 SELECT * FROM workbench_body_stages;
  DROP TABLE workbench_body_stages;
  ALTER TABLE workbench_body_stages_v16 RENAME TO workbench_body_stages;
` }, { version: 17, sql: `
  ALTER TABLE workbench_archive_jobs ADD COLUMN scan_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workbench_archive_jobs ADD COLUMN target_id TEXT;
  ALTER TABLE workbench_archive_jobs ADD COLUMN target_seen INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE workbench_archive_jobs ADD COLUMN coverage_error TEXT;
  CREATE TABLE workbench_archive_scan_items_v17 (
    conversation_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL, id TEXT NOT NULL,
    PRIMARY KEY(conversation_id,kind,generation,id),
    FOREIGN KEY(conversation_id,kind) REFERENCES workbench_archive_jobs(conversation_id,kind) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  INSERT INTO workbench_archive_scan_items_v17 SELECT conversation_id,kind,0,id FROM workbench_archive_scan_items;
  DROP TABLE workbench_archive_scan_items;
  ALTER TABLE workbench_archive_scan_items_v17 RENAME TO workbench_archive_scan_items;
  CREATE TABLE workbench_archive_scan_cursors_v17 (
    conversation_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(conversation_id,kind,generation,digest),
    FOREIGN KEY(conversation_id,kind) REFERENCES workbench_archive_jobs(conversation_id,kind) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  INSERT INTO workbench_archive_scan_cursors_v17 SELECT conversation_id,kind,0,digest FROM workbench_archive_scan_cursors;
  DROP TABLE workbench_archive_scan_cursors;
  ALTER TABLE workbench_archive_scan_cursors_v17 RENAME TO workbench_archive_scan_cursors;
  CREATE TABLE workbench_archive_gc (
    conversation_id TEXT NOT NULL, kind TEXT NOT NULL, through_generation INTEGER NOT NULL,
    PRIMARY KEY(conversation_id,kind),
    FOREIGN KEY(conversation_id,kind) REFERENCES workbench_archive_jobs(conversation_id,kind) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
` }, { version: 18, sql: `
  CREATE TABLE execution_stop_requests (
    operation_id TEXT PRIMARY KEY REFERENCES workbench_operations(id),
    wire_digest TEXT NOT NULL,
    groups_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE execution_associated_requests (
    request_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES workbench_operations(id),
    kind TEXT NOT NULL CHECK(kind='wake'),
    wire_digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE execution_observation_requests (
    request_id TEXT PRIMARY KEY,
    admission_id TEXT NOT NULL REFERENCES execution_admissions(id),
    wire_digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE execution_scope_registration (
    id INTEGER PRIMARY KEY CHECK(id=1),
    workspace_id TEXT NOT NULL REFERENCES workbench_workspaces(id),
    group_id TEXT NOT NULL REFERENCES execution_groups(id),
    cursor_workspace TEXT NOT NULL DEFAULT '',
    cursor_group TEXT NOT NULL DEFAULT '',
    neighbors_json TEXT NOT NULL DEFAULT '[]',
    scanned INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX execution_pending_admission ON execution_pending(admission_id);
` }, { version: 19, sql: `
  ALTER TABLE workbench_archive_jobs ADD COLUMN refresh_after TEXT;
  CREATE INDEX workbench_pending_items ON workbench_items(conversation_id,id) WHERE status='running';
  CREATE INDEX workbench_pending_live_items ON workbench_live_items(conversation_id,id) WHERE status='running';
` }, { version: 20, sql: `
  ALTER TABLE workbench_archive_jobs ADD COLUMN working INTEGER NOT NULL DEFAULT 0 CHECK(working IN (0,1));
` }, { version: 21, sql: `
  DROP INDEX workbench_pending_items;
  DROP INDEX workbench_pending_live_items;
  CREATE INDEX workbench_pending_items ON workbench_items(conversation_id,id) WHERE status='running' OR json_extract(metadata_json,'$.previewOnly')=1;
  CREATE INDEX workbench_pending_live_items ON workbench_live_items(conversation_id,id) WHERE status='running' OR json_extract(metadata_json,'$.previewOnly')=1;
` }, { version: 22, sql: `
  CREATE INDEX workbench_operations_message_state ON workbench_operations(conversation_id,type,status,sequence);
  CREATE TABLE workbench_resource_gc (id TEXT PRIMARY KEY REFERENCES workbench_resources(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
  CREATE INDEX workbench_resource_gc_due ON workbench_resource_gc(created_at,id);
  INSERT INTO workbench_resource_gc SELECT id,created_at,length(data) FROM workbench_resources r WHERE NOT EXISTS(SELECT 1 FROM workbench_resource_refs f WHERE f.resource_id=r.id);
  CREATE TRIGGER workbench_resource_created AFTER INSERT ON workbench_resources BEGIN
    INSERT INTO workbench_resource_gc VALUES(NEW.id,NEW.created_at,length(NEW.data));
  END;
  CREATE TRIGGER workbench_resource_updated AFTER UPDATE OF created_at,data ON workbench_resources BEGIN
    UPDATE workbench_resource_gc SET created_at=NEW.created_at,bytes=length(NEW.data) WHERE id=NEW.id;
  END;
  CREATE TRIGGER workbench_resource_pinned AFTER INSERT ON workbench_resource_refs BEGIN
    DELETE FROM workbench_resource_gc WHERE id=NEW.resource_id;
  END;
  CREATE TRIGGER workbench_resource_unpinned AFTER DELETE ON workbench_resource_refs BEGIN
    INSERT OR IGNORE INTO workbench_resource_gc SELECT id,created_at,length(data) FROM workbench_resources r WHERE id=OLD.resource_id AND NOT EXISTS(SELECT 1 FROM workbench_resource_refs f WHERE f.resource_id=r.id);
  END;
  ALTER TABLE workbench_bodies ADD COLUMN retained INTEGER NOT NULL DEFAULT 0 CHECK(retained IN (0,1));
  ALTER TABLE workbench_bodies ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX workbench_body_refs_version ON workbench_body_refs(version);
  CREATE INDEX workbench_body_stages_version ON workbench_body_stages(version);
  UPDATE workbench_bodies SET retained=EXISTS(SELECT 1 FROM workbench_body_refs r WHERE r.version=workbench_bodies.version),
    stored_bytes=COALESCE((SELECT SUM(length(data)) FROM workbench_body_chunks c WHERE c.version=workbench_bodies.version),0);
  CREATE TABLE workbench_body_usage (id INTEGER PRIMARY KEY CHECK(id=1), transient_bytes INTEGER NOT NULL, manifests INTEGER NOT NULL, stages INTEGER NOT NULL) STRICT;
  INSERT INTO workbench_body_usage SELECT 1,COALESCE(SUM(CASE WHEN retained=0 THEN stored_bytes ELSE 0 END),0),COUNT(*),(SELECT COUNT(*) FROM workbench_body_stages) FROM workbench_bodies;
  CREATE TABLE workbench_body_gc (version TEXT PRIMARY KEY REFERENCES workbench_bodies(version) ON DELETE CASCADE) STRICT, WITHOUT ROWID;
  INSERT INTO workbench_body_gc SELECT version FROM workbench_bodies b WHERE retained=0 AND NOT EXISTS(SELECT 1 FROM workbench_body_stages s WHERE s.version=b.version);
  CREATE TABLE workbench_body_heads (conversation_id TEXT NOT NULL, item_id TEXT NOT NULL, field TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(conversation_id,item_id,field)) STRICT, WITHOUT ROWID;
  CREATE TABLE workbench_body_retire (conversation_id TEXT NOT NULL, item_id TEXT NOT NULL, field TEXT NOT NULL, PRIMARY KEY(conversation_id,item_id,field)) STRICT, WITHOUT ROWID;
  CREATE TRIGGER workbench_body_created AFTER INSERT ON workbench_bodies BEGIN
    UPDATE workbench_body_usage SET manifests=manifests+1 WHERE id=1;
    INSERT INTO workbench_body_gc VALUES(NEW.version);
  END;
  CREATE TRIGGER workbench_body_deleted AFTER DELETE ON workbench_bodies BEGIN
    UPDATE workbench_body_usage SET manifests=manifests-1 WHERE id=1;
  END;
  CREATE TRIGGER workbench_body_chunk_created AFTER INSERT ON workbench_body_chunks BEGIN
    UPDATE workbench_body_usage SET transient_bytes=transient_bytes+CASE WHEN (SELECT retained FROM workbench_bodies WHERE version=NEW.version)=0 THEN length(NEW.data) ELSE 0 END WHERE id=1;
    UPDATE workbench_bodies SET stored_bytes=stored_bytes+length(NEW.data) WHERE version=NEW.version;
  END;
  CREATE TRIGGER workbench_body_chunk_deleted AFTER DELETE ON workbench_body_chunks BEGIN
    UPDATE workbench_body_usage SET transient_bytes=transient_bytes-CASE WHEN (SELECT retained FROM workbench_bodies WHERE version=OLD.version)=0 THEN length(OLD.data) ELSE 0 END WHERE id=1;
    UPDATE workbench_bodies SET stored_bytes=stored_bytes-length(OLD.data) WHERE version=OLD.version;
  END;
  CREATE TRIGGER workbench_body_chunk_updated AFTER UPDATE OF data ON workbench_body_chunks BEGIN
    UPDATE workbench_body_usage SET transient_bytes=transient_bytes+CASE WHEN (SELECT retained FROM workbench_bodies WHERE version=NEW.version)=0 THEN length(NEW.data)-length(OLD.data) ELSE 0 END WHERE id=1;
    UPDATE workbench_bodies SET stored_bytes=stored_bytes+length(NEW.data)-length(OLD.data) WHERE version=NEW.version;
  END;
  CREATE TRIGGER workbench_body_published AFTER INSERT ON workbench_body_refs BEGIN
    UPDATE workbench_body_usage SET transient_bytes=transient_bytes-COALESCE((SELECT stored_bytes FROM workbench_bodies WHERE version=NEW.version AND retained=0),0) WHERE id=1;
    UPDATE workbench_bodies SET retained=1 WHERE version=NEW.version;
    DELETE FROM workbench_body_gc WHERE version=NEW.version;
  END;
  CREATE TRIGGER workbench_body_stage_created AFTER INSERT ON workbench_body_stages BEGIN
    UPDATE workbench_body_usage SET stages=stages+1 WHERE id=1;
    DELETE FROM workbench_body_gc WHERE version=NEW.version;
  END;
  CREATE TRIGGER workbench_body_stage_deleted AFTER DELETE ON workbench_body_stages BEGIN
    UPDATE workbench_body_usage SET stages=stages-1 WHERE id=1;
    INSERT OR IGNORE INTO workbench_body_gc SELECT version FROM workbench_bodies b WHERE version=OLD.version AND retained=0 AND NOT EXISTS(SELECT 1 FROM workbench_body_stages s WHERE s.version=b.version);
    DELETE FROM workbench_body_heads WHERE conversation_id=OLD.conversation_id AND item_id=OLD.item_id AND field=OLD.field AND NOT EXISTS(SELECT 1 FROM workbench_body_stages s WHERE s.conversation_id=OLD.conversation_id AND s.item_id=OLD.item_id AND s.field=OLD.field);
  END;
` }, { version: 23, sql: `
  DELETE FROM workbench_body_heads;
  DELETE FROM workbench_body_retire;
  ALTER TABLE workbench_body_heads ADD COLUMN generation TEXT;
  ALTER TABLE workbench_body_heads ADD COLUMN sequence INTEGER;
  CREATE TABLE workbench_body_stage_revisions (stage_id TEXT PRIMARY KEY REFERENCES workbench_body_stages(id) ON DELETE CASCADE, generation TEXT NOT NULL, sequence INTEGER NOT NULL) STRICT;
  ALTER TABLE workbench_body_usage ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0;
  UPDATE workbench_body_usage SET reserved_bytes=(SELECT COALESCE(SUM(bytes),0) FROM workbench_bodies WHERE retained=0);
  CREATE TRIGGER workbench_body_reserved AFTER INSERT ON workbench_bodies BEGIN
    UPDATE workbench_body_usage SET reserved_bytes=reserved_bytes+NEW.bytes WHERE id=1;
  END;
  CREATE TRIGGER workbench_body_unreserved AFTER DELETE ON workbench_bodies WHEN OLD.retained=0 BEGIN
    UPDATE workbench_body_usage SET reserved_bytes=reserved_bytes-OLD.bytes WHERE id=1;
  END;
  CREATE TRIGGER workbench_body_retained AFTER UPDATE OF retained ON workbench_bodies WHEN OLD.retained=0 AND NEW.retained=1 BEGIN
    UPDATE workbench_body_usage SET reserved_bytes=reserved_bytes-NEW.bytes WHERE id=1;
  END;
` }, { version: 24, sql: `
  CREATE TABLE plugin_source_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    harness TEXT NOT NULL CHECK(harness IN ('codex','dsh')),
    command_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('applying','unknown','applied','failed'))
  ) STRICT;
  CREATE INDEX plugin_source_operations_current ON plugin_source_operations(harness,sequence DESC);
  CREATE UNIQUE INDEX plugin_source_operations_pending ON plugin_source_operations(harness) WHERE status IN ('applying','unknown');
` }, { version: 25, sql: `
  CREATE TABLE execution_host_groups (group_id TEXT PRIMARY KEY REFERENCES execution_groups(id), harness TEXT NOT NULL CHECK(harness IN ('codex','dsh'))) STRICT;
  CREATE INDEX execution_host_harness_groups ON execution_host_groups(harness,group_id);
  CREATE TABLE execution_host_admissions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    harness TEXT NOT NULL CHECK(harness IN ('codex','dsh')),
    kind TEXT NOT NULL CHECK(kind IN ('plugin','source')),
    command_json TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    wire_digest TEXT,
    status TEXT NOT NULL CHECK(status IN ('applying','unknown','restart-required','applied','failed')),
    dispatchable INTEGER NOT NULL CHECK(dispatchable IN (0,1))
  ) STRICT;
  CREATE TABLE execution_host_members (operation_id TEXT NOT NULL REFERENCES execution_host_admissions(operation_id), group_id TEXT NOT NULL REFERENCES execution_groups(id), PRIMARY KEY(operation_id,group_id)) STRICT, WITHOUT ROWID;
  CREATE TABLE execution_host_pending (group_id TEXT NOT NULL REFERENCES execution_groups(id), sequence INTEGER NOT NULL, admission_id TEXT NOT NULL, PRIMARY KEY(group_id,sequence,admission_id)) STRICT, WITHOUT ROWID;
  CREATE INDEX execution_host_pending_admission ON execution_host_pending(admission_id);
  ALTER TABLE execution_freezes ADD COLUMN host_through_sequence INTEGER NOT NULL DEFAULT 0;
` }, { version: 26, sql: `
  DROP INDEX workbench_pending_items;
  DROP INDEX workbench_pending_live_items;
  CREATE INDEX workbench_pending_items ON workbench_items(conversation_id,id) WHERE status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1;
  CREATE INDEX workbench_pending_live_items ON workbench_live_items(conversation_id,id) WHERE status='running' OR json_extract(metadata_json,'$.previewOnly')=1 OR json_extract(metadata_json,'$.mediaPending')=1;
` }, { version: 27, sql: `
  CREATE TABLE workbench_operation_payloads (
    operation_id TEXT PRIMARY KEY REFERENCES workbench_operations(id),
    encoding TEXT NOT NULL CHECK(encoding='gzip-v1'),
    raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 1048576),
    raw_digest TEXT NOT NULL,
    data BLOB NOT NULL
  ) STRICT;
  CREATE TABLE workbench_operation_compaction (
    sequence INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES workbench_operations(id)
  ) STRICT;
  CREATE TABLE workbench_operation_compaction_scan (id INTEGER PRIMARY KEY CHECK(id=1), through_sequence INTEGER NOT NULL, after_sequence INTEGER NOT NULL DEFAULT 0) STRICT;
  INSERT INTO workbench_operation_compaction_scan SELECT 1,COALESCE(MAX(sequence),0),0 FROM workbench_operations;
  CREATE TRIGGER workbench_operation_compact_rejected AFTER UPDATE OF status ON workbench_operations WHEN NEW.status='rejected' AND length(CAST(NEW.payload_json AS BLOB))>=1024 BEGIN
    INSERT OR IGNORE INTO workbench_operation_compaction VALUES(NEW.sequence,NEW.id);
  END;
  CREATE TRIGGER workbench_operation_compact_settled AFTER UPDATE OF kind ON execution_admissions WHEN NEW.kind='settled' AND NEW.current_operation IS NOT NULL BEGIN
    INSERT OR IGNORE INTO workbench_operation_compaction SELECT sequence,id FROM workbench_operations WHERE id=NEW.current_operation AND status IN ('accepted','rejected') AND length(CAST(payload_json AS BLOB))>=1024;
  END;
` }, { version: 28, sql: `
  CREATE INDEX workbench_conversations_workspace_created ON workbench_conversations(workspace_id,created_at,id);
` }, { version: 29, sql: `
  CREATE TABLE workbench_turn_files_limited (
    conversation_id TEXT NOT NULL REFERENCES workbench_conversations(id),
    run_id TEXT NOT NULL,
    PRIMARY KEY(conversation_id,run_id)
  ) STRICT;
` }, { version: 30, sql: `
  CREATE TABLE workbench_archive_updates (
    conversation_id TEXT PRIMARY KEY REFERENCES workbench_conversations(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL,
    cursor TEXT,
    complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
    last_success_at INTEGER
  ) STRICT;
  INSERT INTO workbench_archive_updates(conversation_id,binding_id)
    SELECT id,json_extract(binding_json,'$.id') FROM workbench_conversations WHERE binding_json IS NOT NULL;
  CREATE TRIGGER workbench_archive_updates_binding AFTER UPDATE OF binding_json ON workbench_conversations
    WHEN NEW.binding_json IS NOT NULL BEGIN
    INSERT OR IGNORE INTO workbench_archive_updates(conversation_id,binding_id)
      VALUES(NEW.id,json_extract(NEW.binding_json,'$.id'));
  END;
` }, { version: 31, sql: `
  CREATE INDEX execution_native_observation_pending ON execution_admissions(conversation_id,binding_id,workspace_id,directory_identity,sequence,id)
    WHERE source='native' AND source_key GLOB 'observe:*' AND kind<>'settled';
` }];

/** Runs inside restoreDatabase's private staging transaction, before the database is published. */
export function afterProductRestore(db: DatabaseSync): void {
  // Auth-only backups predate the workbench; normal startup will apply its migration.
  if (!db.prepare('SELECT version FROM app_migrations WHERE version=2').get()) return;
  if (db.prepare('SELECT version FROM app_migrations WHERE version=15').get()) {
    // A database backup cannot prove what a still-live native Host accepted
    // after that backup. Retain every window, intent, admission and save journal;
    // neither an empty restored pending set nor old idle facts may authorize
    // writing or process shutdown. Existing windows need explicit reconciliation.
    db.exec(`UPDATE execution_groups SET revision=revision+1,
      gate_json=json_set(gate_json,'$.revision',revision+1,'$.baselineComplete',json('false'),
        '$.phase','unknown','$.error','execution_restore_requires_reconciliation');
      DELETE FROM execution_baselines; DELETE FROM execution_baseline_sources;`);
  }
  if (db.prepare('SELECT version FROM app_migrations WHERE version=6').get())
    db.exec("UPDATE workbench_queues SET pause='restored',version=version+1 WHERE EXISTS (SELECT 1 FROM workbench_queue_entries WHERE conversation_id=workbench_queues.conversation_id AND content_json IS NOT NULL)");
  const at = Date.now();
  // Restore already runs in a private staging transaction. Set-based SQL keeps
  // every affected conversation invalid without materializing lifetime rows in
  // JavaScript or treating a display page limit as a migration limit.
  db.prepare(`INSERT INTO workbench_changes(conversation_id,created_at)
    SELECT DISTINCT conversation_id,? FROM workbench_operations WHERE status IN ('queued','dispatching')`).run(at);
  db.exec(`UPDATE workbench_conversations SET state_json=json_set(state_json,
    '$.status','unknown','$.configurationVerified',json('false'),'$.reason','database_restored_requires_reconciliation')
    WHERE id IN (SELECT conversation_id FROM workbench_operations WHERE status IN ('queued','dispatching'))`);
  db.prepare("UPDATE workbench_operations SET status='unknown',reason='database_restored_requires_reconciliation',updated_at=? WHERE status IN ('queued','dispatching')").run(at);
  db.exec('DELETE FROM workbench_changes WHERE sequence <= (SELECT sequence FROM workbench_changes ORDER BY sequence DESC LIMIT 1 OFFSET 2000)');
}
