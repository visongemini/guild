import type { DatabaseSync } from "node:sqlite";
import { persistenceError } from "./errors.js";

export const SCHEMA_VERSION = 20;

const MIGRATION_V1 = String.raw`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) > 0),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
) STRICT;

CREATE TABLE guild_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) > 0),
  owning_window_id TEXT CHECK(owning_window_id IS NULL OR length(owning_window_id) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE session_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  codec_version INTEGER NOT NULL CHECK(codec_version = 1),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) > 0),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE runs (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL CHECK(length(run_id) > 0),
  codec_version INTEGER NOT NULL CHECK(codec_version = 1),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) > 0),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, run_id)
) STRICT;

CREATE UNIQUE INDEX runs_one_current_per_task
  ON runs(task_id) WHERE is_current = 1;

CREATE TABLE permission_requests (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
  adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
  window_id TEXT NOT NULL CHECK(length(window_id) > 0),
  registration_key TEXT NOT NULL UNIQUE CHECK(length(registration_key) > 0),
  codec_version INTEGER NOT NULL CHECK(codec_version = 1),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) > 0),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
  decision_commit_json TEXT,
  decision_commit_sha256 TEXT,
  decision_command_id TEXT,
  decision_outbox_version INTEGER,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, run_id, session_id, tool_call_id, adapter_epoch, window_id),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT,
  CHECK(
    (decision_commit_json IS NULL
      AND decision_commit_sha256 IS NULL
      AND decision_command_id IS NULL
      AND decision_outbox_version IS NULL)
    OR
    (decision_commit_json IS NOT NULL
      AND length(decision_commit_json) > 0
      AND decision_commit_sha256 IS NOT NULL
      AND length(decision_commit_sha256) = 64
      AND (
        (decision_command_id IS NULL AND decision_outbox_version IS NULL)
        OR
        (decision_command_id IS NOT NULL
          AND length(decision_command_id) > 0
          AND decision_outbox_version >= 1)
      ))
  )
) STRICT;

CREATE TABLE permission_outbox (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) > 0),
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  adapter_epoch INTEGER NOT NULL,
  window_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  command_json TEXT NOT NULL CHECK(length(command_json) > 0),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256) = 64),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('pending', 'in_flight', 'completed', 'delivery_uncertain')),
  delivery_attempt_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  UNIQUE(task_id, run_id, session_id, tool_call_id, adapter_epoch, window_id),
  UNIQUE(delivery_attempt_id),
  FOREIGN KEY(task_id, run_id, session_id, tool_call_id, adapter_epoch, window_id)
    REFERENCES permission_requests(task_id, run_id, session_id, tool_call_id, adapter_epoch, window_id)
    ON DELETE RESTRICT,
  CHECK(
    (lifecycle = 'pending' AND delivery_attempt_id IS NULL)
    OR
    (lifecycle IN ('in_flight', 'completed', 'delivery_uncertain')
      AND delivery_attempt_id IS NOT NULL
      AND length(delivery_attempt_id) > 0)
  )
) STRICT;

CREATE TABLE committed_envelopes (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
  ingest_mode TEXT NOT NULL CHECK(ingest_mode IN ('live', 'replay')),
  receive_sequence INTEGER NOT NULL CHECK(receive_sequence >= 1),
  event_json TEXT NOT NULL CHECK(length(event_json) > 0),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64),
  committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms >= 0),
  PRIMARY KEY(task_id, idempotency_key),
  UNIQUE(task_id, adapter_epoch, receive_sequence)
) STRICT;

CREATE TRIGGER permission_decision_commit_is_immutable
BEFORE UPDATE OF decision_commit_json, decision_commit_sha256, decision_command_id, decision_outbox_version
ON permission_requests
WHEN OLD.decision_commit_json IS NOT NULL AND (
  NEW.decision_commit_json IS NOT OLD.decision_commit_json
  OR NEW.decision_commit_sha256 IS NOT OLD.decision_commit_sha256
  OR NEW.decision_command_id IS NOT OLD.decision_command_id
  OR NEW.decision_outbox_version IS NOT OLD.decision_outbox_version
)
BEGIN
  SELECT RAISE(ABORT, 'permission_decision_immutable');
END;

CREATE TRIGGER permission_outbox_identity_is_immutable
BEFORE UPDATE OF command_id, task_id, run_id, session_id, tool_call_id, adapter_epoch,
  window_id, version, command_json, command_sha256, created_at_ms
ON permission_outbox
WHEN
  NEW.command_id IS NOT OLD.command_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.tool_call_id IS NOT OLD.tool_call_id
  OR NEW.adapter_epoch IS NOT OLD.adapter_epoch
  OR NEW.window_id IS NOT OLD.window_id
  OR NEW.version IS NOT OLD.version
  OR NEW.command_json IS NOT OLD.command_json
  OR NEW.command_sha256 IS NOT OLD.command_sha256
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'permission_outbox_immutable');
END;

CREATE TRIGGER permission_outbox_lifecycle_is_monotonic
BEFORE UPDATE OF lifecycle, delivery_attempt_id
ON permission_outbox
WHEN NOT (
  (OLD.lifecycle = 'pending'
    AND NEW.lifecycle = 'in_flight'
    AND OLD.delivery_attempt_id IS NULL
    AND NEW.delivery_attempt_id IS NOT NULL)
  OR
  (OLD.lifecycle = 'in_flight'
    AND NEW.lifecycle IN ('completed', 'delivery_uncertain')
    AND NEW.delivery_attempt_id IS OLD.delivery_attempt_id)
  OR
  (OLD.lifecycle = 'delivery_uncertain'
    AND NEW.lifecycle = 'completed'
    AND NEW.delivery_attempt_id IS OLD.delivery_attempt_id)
  OR
  (NEW.lifecycle IS OLD.lifecycle
    AND NEW.delivery_attempt_id IS OLD.delivery_attempt_id)
)
BEGIN
  SELECT RAISE(ABORT, 'permission_outbox_non_monotonic');
END;

CREATE TRIGGER permission_outbox_delete_only_pending
BEFORE DELETE ON permission_outbox
WHEN OLD.lifecycle <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'permission_outbox_delete_after_claim');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(1, 'initial_authoritative_aggregates', CAST(unixepoch('subsec') * 1000 AS INTEGER));

INSERT INTO guild_meta(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
VALUES(1, 1, 1, NULL);
`;

const MIGRATION_V2 = String.raw`
CREATE TABLE committed_envelopes_next (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) > 0),
  adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
  ingest_mode TEXT NOT NULL CHECK(ingest_mode IN ('live', 'replay')),
  receive_sequence INTEGER NOT NULL CHECK(receive_sequence >= 1),
  event_json TEXT NOT NULL CHECK(length(event_json) > 0),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64),
  committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms >= 0),
  PRIMARY KEY(task_id, idempotency_key),
  UNIQUE(task_id, adapter_epoch, receive_sequence)
) STRICT;

INSERT INTO committed_envelopes_next(
  task_id, idempotency_key, fingerprint, adapter_epoch, ingest_mode,
  receive_sequence, event_json, event_sha256, committed_at_ms
)
SELECT task_id, idempotency_key, fingerprint, adapter_epoch, ingest_mode,
  receive_sequence, event_json, event_sha256, committed_at_ms
FROM committed_envelopes;

DROP TABLE committed_envelopes;
ALTER TABLE committed_envelopes_next RENAME TO committed_envelopes;

CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 2),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 2, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 128),
  canonical_path TEXT NOT NULL UNIQUE CHECK(length(canonical_path) BETWEEN 1 AND 4096),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 256),
  disposition TEXT NOT NULL CHECK(disposition IN ('active', 'archived', 'deleted')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  archived_at_ms INTEGER CHECK(archived_at_ms IS NULL OR archived_at_ms >= created_at_ms),
  deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms),
  CHECK(
    (disposition = 'active' AND archived_at_ms IS NULL AND deleted_at_ms IS NULL)
    OR (disposition = 'archived' AND archived_at_ms IS NOT NULL AND deleted_at_ms IS NULL)
    OR (disposition = 'deleted' AND deleted_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE task_metadata (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 512),
  disposition TEXT NOT NULL CHECK(disposition IN ('active', 'archived', 'deleted')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  last_activity_at_ms INTEGER NOT NULL CHECK(last_activity_at_ms >= created_at_ms),
  archived_at_ms INTEGER CHECK(archived_at_ms IS NULL OR archived_at_ms >= created_at_ms),
  deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms),
  CHECK(
    (disposition = 'active' AND archived_at_ms IS NULL AND deleted_at_ms IS NULL)
    OR (disposition = 'archived' AND archived_at_ms IS NOT NULL AND deleted_at_ms IS NULL)
    OR (disposition = 'deleted' AND deleted_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX task_metadata_workspace_activity
  ON task_metadata(workspace_id, disposition, last_activity_at_ms DESC, task_id);

CREATE TABLE adapter_epochs (
  task_id TEXT NOT NULL REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  status TEXT NOT NULL CHECK(status IN ('spawning', 'alive', 'stopping', 'exited')),
  is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, adapter_epoch),
  UNIQUE(task_id, session_id, adapter_epoch),
  CHECK(
    (status = 'exited' AND is_current = 0)
    OR (status <> 'exited' AND is_current = 1)
  )
) STRICT;

CREATE UNIQUE INDEX adapter_epochs_one_current_per_task
  ON adapter_epochs(task_id) WHERE is_current = 1;

CREATE TABLE prompt_correlations (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
  prompt_sequence INTEGER NOT NULL CHECK(prompt_sequence >= 1),
  acceptance_key TEXT NOT NULL CHECK(length(acceptance_key) > 0),
  acceptance_fingerprint TEXT NOT NULL CHECK(length(acceptance_fingerprint) = 64),
  status TEXT NOT NULL CHECK(status IN ('accepted', 'terminal')),
  terminal_classification TEXT CHECK(
    terminal_classification IS NULL
    OR terminal_classification IN ('cancelled', 'completed', 'refused', 'truncated')
  ),
  terminal_key TEXT,
  final_commit_key TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, run_id),
  UNIQUE(task_id, session_id, adapter_epoch, prompt_sequence),
  UNIQUE(task_id, acceptance_key),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY(task_id, adapter_epoch) REFERENCES adapter_epochs(task_id, adapter_epoch) ON DELETE RESTRICT,
  CHECK(
    (status = 'accepted' AND terminal_classification IS NULL)
    OR (status = 'terminal' AND terminal_classification IS NOT NULL)
  ),
  CHECK(
    (status = 'accepted' AND terminal_key IS NULL AND final_commit_key IS NULL)
    OR (status = 'terminal' AND terminal_key IS NOT NULL AND length(terminal_key) > 0
      AND (
        (terminal_classification = 'cancelled' AND final_commit_key IS NULL)
        OR (terminal_classification <> 'cancelled'
          AND final_commit_key IS NOT NULL AND length(final_commit_key) > 0)
      ))
  )
) STRICT;

CREATE TABLE conversation_entries (
  task_id TEXT NOT NULL REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 128),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  kind TEXT NOT NULL CHECK(kind IN (
    'user', 'assistant', 'thought', 'tool', 'permission', 'media', 'notice', 'error'
  )),
  run_id TEXT,
  text_content TEXT NOT NULL CHECK(length(text_content) <= 1048576),
  metadata_json TEXT NOT NULL CHECK(length(metadata_json) BETWEEN 2 AND 65536),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  initial_fingerprint TEXT NOT NULL CHECK(length(initial_fingerprint) = 64),
  status TEXT NOT NULL CHECK(status IN ('streaming', 'complete', 'failed')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, entry_id),
  UNIQUE(task_id, sequence),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX conversation_entries_task_sequence
  ON conversation_entries(task_id, sequence);

CREATE TABLE drafts (
  task_id TEXT PRIMARY KEY REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  text_content TEXT NOT NULL CHECK(length(text_content) <= 1048576),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE app_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
  sidebar_width INTEGER NOT NULL CHECK(sidebar_width BETWEEN 220 AND 600),
  browser_sync_enabled INTEGER NOT NULL CHECK(browser_sync_enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO app_settings(
  singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms
) VALUES(1, 'zh-CN', 280, 0, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER));

CREATE TRIGGER workspace_identity_is_immutable
BEFORE UPDATE OF workspace_id, canonical_path, created_at_ms
ON workspaces
WHEN
  NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.canonical_path IS NOT OLD.canonical_path
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'workspace_identity_immutable');
END;

CREATE TRIGGER workspace_disposition_is_monotonic
BEFORE UPDATE OF disposition ON workspaces
WHEN NOT (
  NEW.disposition IS OLD.disposition
  OR (OLD.disposition = 'active' AND NEW.disposition IN ('archived', 'deleted'))
  OR (OLD.disposition = 'archived' AND NEW.disposition = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_disposition_non_monotonic');
END;

CREATE TRIGGER task_workspace_binding_is_immutable
BEFORE UPDATE OF task_id, workspace_id, created_at_ms
ON task_metadata
WHEN
  NEW.task_id IS NOT OLD.task_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'task_workspace_binding_immutable');
END;

CREATE TRIGGER task_disposition_is_monotonic
BEFORE UPDATE OF disposition ON task_metadata
WHEN NOT (
  NEW.disposition IS OLD.disposition
  OR (OLD.disposition = 'active' AND NEW.disposition IN ('archived', 'deleted'))
  OR (OLD.disposition = 'archived' AND NEW.disposition = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'task_disposition_non_monotonic');
END;

CREATE TRIGGER adapter_epoch_identity_is_immutable
BEFORE UPDATE OF task_id, adapter_epoch, session_id, created_at_ms
ON adapter_epochs
WHEN
  NEW.task_id IS NOT OLD.task_id
  OR NEW.adapter_epoch IS NOT OLD.adapter_epoch
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'adapter_epoch_identity_immutable');
END;

CREATE TRIGGER adapter_epoch_status_is_monotonic
BEFORE UPDATE OF status ON adapter_epochs
WHEN NOT (
  NEW.status IS OLD.status
  OR (OLD.status = 'spawning' AND NEW.status IN ('alive', 'stopping', 'exited'))
  OR (OLD.status = 'alive' AND NEW.status IN ('stopping', 'exited'))
  OR (OLD.status = 'stopping' AND NEW.status = 'exited')
)
BEGIN
  SELECT RAISE(ABORT, 'adapter_epoch_status_non_monotonic');
END;

CREATE TRIGGER prompt_correlation_identity_is_immutable
BEFORE UPDATE OF task_id, run_id, session_id, adapter_epoch, prompt_sequence,
  acceptance_key, acceptance_fingerprint, created_at_ms
ON prompt_correlations
WHEN
  NEW.task_id IS NOT OLD.task_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.adapter_epoch IS NOT OLD.adapter_epoch
  OR NEW.prompt_sequence IS NOT OLD.prompt_sequence
  OR NEW.acceptance_key IS NOT OLD.acceptance_key
  OR NEW.acceptance_fingerprint IS NOT OLD.acceptance_fingerprint
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'prompt_correlation_identity_immutable');
END;

CREATE TRIGGER prompt_correlation_status_is_monotonic
BEFORE UPDATE OF status, terminal_classification, terminal_key, final_commit_key
ON prompt_correlations
WHEN NOT (
  (NEW.status IS OLD.status
    AND NEW.terminal_classification IS OLD.terminal_classification
    AND NEW.terminal_key IS OLD.terminal_key
    AND NEW.final_commit_key IS OLD.final_commit_key)
  OR (OLD.status = 'accepted' AND NEW.status = 'terminal'
    AND OLD.terminal_classification IS NULL
    AND NEW.terminal_classification IS NOT NULL
    AND OLD.terminal_key IS NULL AND NEW.terminal_key IS NOT NULL
    AND OLD.final_commit_key IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'prompt_correlation_non_monotonic');
END;

CREATE TRIGGER conversation_entry_is_append_only
BEFORE UPDATE ON conversation_entries
WHEN NOT (
  NEW.task_id IS OLD.task_id
  AND NEW.entry_id IS OLD.entry_id
  AND NEW.sequence IS OLD.sequence
  AND NEW.kind IS OLD.kind
  AND NEW.run_id IS OLD.run_id
  AND NEW.metadata_json IS OLD.metadata_json
  AND NEW.metadata_sha256 IS OLD.metadata_sha256
  AND NEW.initial_fingerprint IS OLD.initial_fingerprint
  AND NEW.created_at_ms IS OLD.created_at_ms
  AND NEW.revision = OLD.revision + 1
  AND NEW.updated_at_ms >= OLD.updated_at_ms
  AND substr(NEW.text_content, 1, length(OLD.text_content)) = OLD.text_content
  AND (
    (OLD.status = 'streaming' AND NEW.status IN ('streaming', 'complete', 'failed'))
    OR (OLD.status IN ('complete', 'failed') AND NEW.status IS OLD.status)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_entry_not_append_only');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(2, 'workspace_conversation_and_settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V3 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 3),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 3, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE queued_turns (
  task_id TEXT NOT NULL REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  queue_id TEXT NOT NULL CHECK(length(queue_id) BETWEEN 1 AND 128),
  intended_session_id TEXT NOT NULL CHECK(length(intended_session_id) BETWEEN 1 AND 512),
  reserved_run_id TEXT NOT NULL CHECK(length(reserved_run_id) BETWEEN 1 AND 512),
  entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 128),
  text_content TEXT NOT NULL CHECK(length(text_content) BETWEEN 1 AND 1048576),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(task_id, queue_id),
  UNIQUE(task_id, reserved_run_id),
  UNIQUE(task_id, entry_id)
) STRICT;

CREATE INDEX queued_turns_task_order
  ON queued_turns(task_id, created_at_ms, queue_id);

CREATE TRIGGER queued_turn_is_immutable
BEFORE UPDATE ON queued_turns
BEGIN
  SELECT RAISE(ABORT, 'queued_turn_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(3, 'durable_queued_turns', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V4 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 4),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 4, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

DROP TRIGGER workspace_disposition_is_monotonic;
CREATE TRIGGER workspace_disposition_is_monotonic
BEFORE UPDATE OF disposition ON workspaces
WHEN NOT (
  NEW.disposition IS OLD.disposition
  OR (OLD.disposition = 'active' AND NEW.disposition IN ('archived', 'deleted'))
  OR (OLD.disposition = 'archived' AND NEW.disposition IN ('active', 'deleted'))
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_disposition_non_monotonic');
END;

DROP TRIGGER task_disposition_is_monotonic;
CREATE TRIGGER task_disposition_is_monotonic
BEFORE UPDATE OF disposition ON task_metadata
WHEN NOT (
  NEW.disposition IS OLD.disposition
  OR (OLD.disposition = 'active' AND NEW.disposition IN ('archived', 'deleted'))
  OR (OLD.disposition = 'archived' AND NEW.disposition IN ('active', 'deleted'))
)
BEGIN
  SELECT RAISE(ABORT, 'task_disposition_non_monotonic');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(4, 'reversible_archives', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V5 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 5),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 5, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE app_settings
ADD COLUMN grok_model TEXT NOT NULL DEFAULT 'grok-4.6'
CHECK(grok_model IN ('grok-4.6', 'grok-4.5'));

ALTER TABLE app_settings
ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'xhigh'
CHECK(reasoning_effort IN ('xhigh', 'high', 'medium', 'low'));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(5, 'official_grok_runtime_settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V6 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 6),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 6, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE app_settings
ADD COLUMN nickname TEXT NOT NULL DEFAULT 'BDV'
CHECK(length(nickname) BETWEEN 1 AND 512);

ALTER TABLE app_settings
ADD COLUMN avatar_filename TEXT
CHECK(avatar_filename IS NULL OR length(avatar_filename) BETWEEN 1 AND 80);

ALTER TABLE app_settings
ADD COLUMN restore_last_task INTEGER NOT NULL DEFAULT 1
CHECK(restore_last_task IN (0, 1));

ALTER TABLE app_settings
ADD COLUMN new_task_workspace_mode TEXT NOT NULL DEFAULT 'ask'
CHECK(new_task_workspace_mode IN ('ask', 'last'));

ALTER TABLE app_settings
ADD COLUMN last_active_task_id TEXT
CHECK(last_active_task_id IS NULL OR length(last_active_task_id) BETWEEN 1 AND 512);

ALTER TABLE app_settings
ADD COLUMN last_workspace_id TEXT
CHECK(last_workspace_id IS NULL OR length(last_workspace_id) BETWEEN 1 AND 512);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(6, 'profile_and_general_settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V7 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 7),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 7, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE app_settings
ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
CHECK(permission_mode IN ('default', 'bypassPermissions'));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(7, 'official_grok_permission_mode', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V8 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 8),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 8, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE session_context_windows (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  size INTEGER NOT NULL CHECK(size > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(8, 'official_session_context_capacity', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V9 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 9),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 9, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE task_metadata
ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
CHECK(pinned IN (0, 1));

CREATE INDEX task_metadata_workspace_pinned_activity
  ON task_metadata(workspace_id, disposition, pinned DESC, last_activity_at_ms DESC, task_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(9, 'pinned_conversations', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V10 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 10),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 10, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE app_settings
ADD COLUMN task_notifications_enabled INTEGER NOT NULL DEFAULT 1
CHECK(task_notifications_enabled IN (0, 1));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(10, 'background_task_notifications', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V11 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 11),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 11, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE app_settings_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
  sidebar_width INTEGER NOT NULL CHECK(sidebar_width BETWEEN 220 AND 600),
  browser_sync_enabled INTEGER NOT NULL CHECK(browser_sync_enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  grok_model TEXT NOT NULL CHECK(grok_model IN ('grok-4.6', 'grok-4.5')),
  reasoning_effort TEXT NOT NULL CHECK(reasoning_effort IN ('xhigh', 'high', 'medium', 'low')),
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 512),
  avatar_filename TEXT CHECK(avatar_filename IS NULL OR length(avatar_filename) BETWEEN 1 AND 80),
  restore_last_task INTEGER NOT NULL CHECK(restore_last_task IN (0, 1)),
  new_task_workspace_mode TEXT NOT NULL CHECK(new_task_workspace_mode IN ('ask', 'last')),
  last_active_task_id TEXT CHECK(last_active_task_id IS NULL OR length(last_active_task_id) BETWEEN 1 AND 512),
  last_workspace_id TEXT CHECK(last_workspace_id IS NULL OR length(last_workspace_id) BETWEEN 1 AND 512),
  permission_mode TEXT NOT NULL CHECK(permission_mode IN (
    'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'
  )),
  web_search_enabled INTEGER NOT NULL CHECK(web_search_enabled IN (0, 1)),
  plan_enabled INTEGER NOT NULL CHECK(plan_enabled IN (0, 1)),
  subagents_enabled INTEGER NOT NULL CHECK(subagents_enabled IN (0, 1)),
  max_turns INTEGER CHECK(max_turns IS NULL OR max_turns BETWEEN 1 AND 10000),
  task_notifications_enabled INTEGER NOT NULL CHECK(task_notifications_enabled IN (0, 1))
) STRICT;

INSERT INTO app_settings_next(
  singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms,
  grok_model, reasoning_effort, nickname, avatar_filename, restore_last_task,
  new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
  web_search_enabled, plan_enabled, subagents_enabled, max_turns,
  task_notifications_enabled
)
SELECT singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms,
  grok_model, reasoning_effort, nickname, avatar_filename, restore_last_task,
  new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
  1, 1, 1, NULL,
  task_notifications_enabled
FROM app_settings;

DROP TABLE app_settings;
ALTER TABLE app_settings_next RENAME TO app_settings;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(11, 'all_official_permission_modes', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V12 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 12),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 12, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

DROP TRIGGER queued_turn_is_immutable;
DROP INDEX queued_turns_task_order;

CREATE TABLE queued_turns_next (
  task_id TEXT NOT NULL REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  queue_id TEXT NOT NULL CHECK(length(queue_id) BETWEEN 1 AND 128),
  intended_session_id TEXT NOT NULL CHECK(length(intended_session_id) BETWEEN 1 AND 512),
  reserved_run_id TEXT NOT NULL CHECK(length(reserved_run_id) BETWEEN 1 AND 512),
  entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 128),
  text_content TEXT NOT NULL CHECK(length(text_content) BETWEEN 1 AND 1048576),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0),
  PRIMARY KEY(task_id, queue_id),
  UNIQUE(task_id, reserved_run_id),
  UNIQUE(task_id, entry_id)
) STRICT;

INSERT INTO queued_turns_next(
  task_id, queue_id, intended_session_id, reserved_run_id,
  entry_id, text_content, created_at_ms, priority
)
SELECT task_id, queue_id, intended_session_id, reserved_run_id,
  entry_id, text_content, created_at_ms, 0
FROM queued_turns;

DROP TABLE queued_turns;
ALTER TABLE queued_turns_next RENAME TO queued_turns;

CREATE INDEX queued_turns_task_order
  ON queued_turns(task_id, priority DESC, created_at_ms, queue_id);

CREATE TRIGGER queued_turn_identity_is_immutable
BEFORE UPDATE OF task_id, queue_id, intended_session_id, reserved_run_id,
  entry_id, text_content, created_at_ms
ON queued_turns
BEGIN
  SELECT RAISE(ABORT, 'queued_turn_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(12, 'queued_turn_priorities', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V13 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 13),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 13, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE continuous_tasks (
  task_id TEXT PRIMARY KEY REFERENCES task_metadata(task_id) ON DELETE RESTRICT,
  objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 1048576),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'blocked', 'stopped')),
  phase TEXT NOT NULL CHECK(phase IN ('work', 'audit')),
  cycle INTEGER NOT NULL CHECK(cycle >= 1),
  last_run_id TEXT,
  summary TEXT,
  remaining TEXT,
  stop_reason TEXT,
  consecutive_no_progress INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_no_progress >= 0),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(task_id, last_run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(13, 'continuous_task_controller', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

const MIGRATION_V14 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 14),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 14, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

DROP TRIGGER workspace_disposition_is_monotonic;
CREATE TRIGGER workspace_disposition_is_monotonic
BEFORE UPDATE OF disposition ON workspaces
WHEN NOT (
  NEW.disposition IS OLD.disposition
  OR (OLD.disposition = 'active' AND NEW.disposition IN ('archived', 'deleted'))
  OR (OLD.disposition = 'archived' AND NEW.disposition IN ('active', 'deleted'))
  OR (OLD.disposition = 'deleted' AND NEW.disposition = 'active'
    AND NOT EXISTS (SELECT 1 FROM task_metadata WHERE workspace_id = OLD.workspace_id AND disposition <> 'deleted'))
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_disposition_non_monotonic');
END;
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(14, 'readd_empty_deleted_workspaces', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// V15 (Guild 2.2 speed plan, WP2/WP3). Metadata-only: no historical row is read or rewritten.
// 1. The append-only guard no longer compares the whole old text against the new text, which was
//    O(n) per update and O(n^2) per streamed message. The store only appends with `||`, so the
//    guard keeps every other column check, requires a strictly increasing revision (a coalesced
//    stream flush advances it by the number of chunks it covers), and keeps two O(1) text
//    checks: the byte length never shrinks and the first 64 characters never change.
// 2. task_context_usage persists the latest exact context occupancy at turn end, so opening a
//    task no longer scans committed_envelopes.
const MIGRATION_V15 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 15),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 15, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

DROP TRIGGER conversation_entry_is_append_only;
CREATE TRIGGER conversation_entry_is_append_only
BEFORE UPDATE ON conversation_entries
WHEN NOT (
  NEW.task_id IS OLD.task_id
  AND NEW.entry_id IS OLD.entry_id
  AND NEW.sequence IS OLD.sequence
  AND NEW.kind IS OLD.kind
  AND NEW.run_id IS OLD.run_id
  AND NEW.metadata_json IS OLD.metadata_json
  AND NEW.metadata_sha256 IS OLD.metadata_sha256
  AND NEW.initial_fingerprint IS OLD.initial_fingerprint
  AND NEW.created_at_ms IS OLD.created_at_ms
  AND NEW.revision > OLD.revision
  AND NEW.updated_at_ms >= OLD.updated_at_ms
  AND octet_length(NEW.text_content) >= octet_length(OLD.text_content)
  AND substr(NEW.text_content, 1, length(substr(OLD.text_content, 1, 64)))
    = substr(OLD.text_content, 1, 64)
  AND (
    (OLD.status = 'streaming' AND NEW.status IN ('streaming', 'complete', 'failed'))
    OR (OLD.status IN ('complete', 'failed') AND NEW.status IS OLD.status)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_entry_not_append_only');
END;

CREATE TABLE task_context_usage (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  tokens_used INTEGER NOT NULL CHECK(tokens_used >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(15, 'streaming_write_path_and_context_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// V16 (F1: model and reasoning effort follow the official runtime list).
// 1. app_settings no longer hard-codes two models and four efforts. grok_model and
//    reasoning_effort accept any bounded safe identifier (an official model id starts with
//    `grok-`), and the empty string is the sentinel for "follow the runtime's advertised
//    default". Every other column and CHECK is copied unchanged.
// 2. One-time data rewrite, approved by the owner on 2026-10-09: exactly the old pair
//    (grok-4.6, xhigh) becomes (grok-4.7, high). Every other pair is left as the owner set it.
//    revision and updated_at_ms are not touched, like every other migration. A brand-new
//    database walks V1..V16 and ends on the sentinel instead (MIGRATION_V16_FRESH_INSTALL).
// 3. task_runtime_settings holds per-task overrides of the global default; a row is an override
//    and a NULL column inherits. runtime_model_catalog caches the last model list the official
//    runtime advertised, so the UI can show choices before any session exists.
const MIGRATION_V16 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 16),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 16, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE app_settings_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
  sidebar_width INTEGER NOT NULL CHECK(sidebar_width BETWEEN 220 AND 600),
  browser_sync_enabled INTEGER NOT NULL CHECK(browser_sync_enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  grok_model TEXT NOT NULL CHECK(grok_model = '' OR (
    length(grok_model) BETWEEN 1 AND 64
    AND grok_model GLOB 'grok-*'
    AND grok_model NOT GLOB '*[^A-Za-z0-9._:-]*'
  )),
  reasoning_effort TEXT NOT NULL CHECK(reasoning_effort = '' OR (
    length(reasoning_effort) BETWEEN 1 AND 32
    AND reasoning_effort GLOB '[a-z]*'
    AND reasoning_effort NOT GLOB '*[^a-z0-9_-]*'
  )),
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 512),
  avatar_filename TEXT CHECK(avatar_filename IS NULL OR length(avatar_filename) BETWEEN 1 AND 80),
  restore_last_task INTEGER NOT NULL CHECK(restore_last_task IN (0, 1)),
  new_task_workspace_mode TEXT NOT NULL CHECK(new_task_workspace_mode IN ('ask', 'last')),
  last_active_task_id TEXT CHECK(last_active_task_id IS NULL OR length(last_active_task_id) BETWEEN 1 AND 512),
  last_workspace_id TEXT CHECK(last_workspace_id IS NULL OR length(last_workspace_id) BETWEEN 1 AND 512),
  permission_mode TEXT NOT NULL CHECK(permission_mode IN (
    'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'
  )),
  web_search_enabled INTEGER NOT NULL CHECK(web_search_enabled IN (0, 1)),
  plan_enabled INTEGER NOT NULL CHECK(plan_enabled IN (0, 1)),
  subagents_enabled INTEGER NOT NULL CHECK(subagents_enabled IN (0, 1)),
  max_turns INTEGER CHECK(max_turns IS NULL OR max_turns BETWEEN 1 AND 10000),
  task_notifications_enabled INTEGER NOT NULL CHECK(task_notifications_enabled IN (0, 1))
) STRICT;

INSERT INTO app_settings_next(
  singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms,
  grok_model, reasoning_effort, nickname, avatar_filename, restore_last_task,
  new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
  web_search_enabled, plan_enabled, subagents_enabled, max_turns,
  task_notifications_enabled
)
SELECT singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms,
  grok_model, reasoning_effort, nickname, avatar_filename, restore_last_task,
  new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
  web_search_enabled, plan_enabled, subagents_enabled, max_turns,
  task_notifications_enabled
FROM app_settings;

DROP TABLE app_settings;
ALTER TABLE app_settings_next RENAME TO app_settings;

UPDATE app_settings
SET grok_model = 'grok-4.7', reasoning_effort = 'high'
WHERE grok_model = 'grok-4.6' AND reasoning_effort = 'xhigh';

CREATE TABLE task_runtime_settings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  model_id TEXT CHECK(model_id IS NULL OR (
    length(model_id) BETWEEN 1 AND 64
    AND model_id GLOB 'grok-*'
    AND model_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )),
  reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR (
    length(reasoning_effort) BETWEEN 1 AND 32
    AND reasoning_effort GLOB '[a-z]*'
    AND reasoning_effort NOT GLOB '*[^a-z0-9_-]*'
  )),
  context_window INTEGER CHECK(context_window IS NULL OR context_window BETWEEN 1 AND 100000000),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TABLE runtime_model_catalog (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  catalog_json TEXT NOT NULL CHECK(length(catalog_json) BETWEEN 2 AND 262144),
  runtime_version TEXT CHECK(runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 128),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(16, 'runtime_model_catalog_and_task_settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// V17 (F4 Steer, F2 run checkpoints). Purely additive: two new tables, no historical row is read
// or rewritten.
// 1. task_interjections records every Steer (`_x.ai/interject`) Guild sent, keyed by the
//    client-made interjection id the runtime echoes back. The conversation entry text is
//    append-only and its metadata immutable, so the mutable delivery state lives here:
//    sending (intent recorded, request in flight) -> pending (runtime accepted it) ->
//    delivered (the runtime echoed the id) | fallen_back (went to the durable queue; the reason is
//    kept) | failed. `started_run_id` links a Steer the runtime ran as its own turn
//    (`interject-fallback-*`) to the Run Guild created for that turn.
// 2. run_checkpoints holds, per Run, the hidden git refs captured at Run start and Run end
//    (refs/guild/checkpoints/<task>/<n>), the stored changed-file summary, and the rewind marker
//    (`rolled_back_at_ms`; the row is kept for audit). A Run without a git work tree still gets a
//    row (status unavailable) so its ordinal and rollback state exist.
const MIGRATION_V17 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 17),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 17, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE task_interjections (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  interjection_id TEXT NOT NULL CHECK(length(interjection_id) BETWEEN 1 AND 64),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 512),
  text_content TEXT NOT NULL CHECK(length(text_content) BETWEEN 1 AND 200000),
  state TEXT NOT NULL CHECK(state IN ('sending', 'pending', 'delivered', 'fallen_back', 'failed')),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 64),
  entry_id TEXT CHECK(entry_id IS NULL OR length(entry_id) BETWEEN 1 AND 128),
  queue_id TEXT CHECK(queue_id IS NULL OR length(queue_id) BETWEEN 1 AND 128),
  started_run_id TEXT CHECK(started_run_id IS NULL OR length(started_run_id) BETWEEN 1 AND 512),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, interjection_id),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX task_interjections_by_run ON task_interjections(task_id, run_id);

CREATE TABLE run_checkpoints (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 512),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  start_ref TEXT CHECK(start_ref IS NULL OR length(start_ref) BETWEEN 1 AND 512),
  end_ref TEXT CHECK(end_ref IS NULL OR length(end_ref) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('capturing', 'captured', 'unavailable', 'rolled_back')),
  detail TEXT CHECK(detail IS NULL OR length(detail) BETWEEN 1 AND 64),
  files_json TEXT NOT NULL CHECK(length(files_json) BETWEEN 2 AND 262144),
  files_total INTEGER NOT NULL CHECK(files_total >= 0),
  adds INTEGER NOT NULL CHECK(adds >= 0),
  dels INTEGER NOT NULL CHECK(dels >= 0),
  rolled_back_at_ms INTEGER CHECK(rolled_back_at_ms IS NULL OR rolled_back_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  PRIMARY KEY(task_id, run_id),
  UNIQUE(task_id, ordinal),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT,
  CHECK((status = 'rolled_back') = (rolled_back_at_ms IS NOT NULL))
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(17, 'steer_interjections_and_run_checkpoints', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// V18 (F3 per-task git worktree). Purely additive: one new table, no historical row is read or
// rewritten. task_worktrees holds, per task that was created with an isolated worktree, where the
// worktree lives, which branch Guild created for it and what it was cut from:
//  - source_repo_path is the repository's top level (a realpath) and worktree_path the worktree
//    root under Guild's own data directory; the task's session folder is worktree_path plus the
//    workspace's sub-folder inside the repository (usually none);
//  - branch is always `guild/...` (the only kind of branch Guild ever deletes), base_commit the
//    source HEAD at creation and base_branch its branch name when HEAD was not detached;
//  - status: active -> applied (merged back; worktree and branch kept) -> active again when new
//    work appears, discarded (worktree and branch removed by the user), missing (the directory or
//    the repository vanished). A discarded row is kept so the task stays readable.
const MIGRATION_V18 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 18),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 18, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE task_worktrees (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  source_repo_path TEXT NOT NULL CHECK(length(source_repo_path) BETWEEN 1 AND 4096),
  worktree_path TEXT NOT NULL CHECK(length(worktree_path) BETWEEN 1 AND 4096),
  branch TEXT NOT NULL CHECK(length(branch) BETWEEN 7 AND 200 AND substr(branch, 1, 6) = 'guild/'),
  base_commit TEXT NOT NULL CHECK(length(base_commit) IN (40, 64)),
  base_branch TEXT CHECK(base_branch IS NULL OR length(base_branch) BETWEEN 1 AND 255),
  status TEXT NOT NULL CHECK(status IN ('active', 'applied', 'discarded', 'missing')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE UNIQUE INDEX task_worktrees_by_path ON task_worktrees(worktree_path);
CREATE UNIQUE INDEX task_worktrees_by_branch ON task_worktrees(source_repo_path, branch);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(18, 'task_worktrees', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// V19 (Guild 3.0 dual engine: PC-ENG-001, PC-MODEL-001, PC-ROUTE-002, PC-PRIV-001). Forward-only;
// no historical conversation, run or permission row is read or rewritten.
// 1. task_metadata.engine ('grok' | 'claude', every existing task is 'grok') is fixed once the task
//    has a Run (trigger); routed_at_ms marks the first switch to an Online / Local model, is only
//    legal on a Claude task and never changes or clears once set (trigger).
// 2. app_settings gains the Claude-engine defaults. Their model and effort accept the empty string
//    ("follow the adapter's default") or a Claude-grammar identifier. The Grok columns and their
//    grok-* CHECK are untouched.
// 3. task_runtime_settings.model_id accepts either engine's grammar (the store validates it against
//    the task's engine). A trigger keeps the old guarantee for Grok tasks: their override is still
//    a bounded official grok-* id, even through raw SQL.
// 4. runtime_model_catalog holds one cached model list per engine; the existing row becomes 'grok'.
// 5. model_sources holds Online / Local endpoints. There is NO secret column: a key is only named
//    (key_file + key_variable) and read by the main process from the user's env file. The URL CHECK
//    refuses user info, query and fragment so a key cannot ride along in the address, and
//    confirmed_host (written only after the native confirmation) must be part of the base URL.
// 6. workspace_prefs keeps per-workspace privacy choices; thinking_provenance maps the hash of a
//    thinking signature to the source that produced it (the store prunes it to a bounded size).
const MIGRATION_V19 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 19),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 19, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

ALTER TABLE task_metadata
ADD COLUMN engine TEXT NOT NULL DEFAULT 'grok'
CHECK(engine IN ('grok', 'claude'));

ALTER TABLE task_metadata
ADD COLUMN routed_at_ms INTEGER
CHECK(routed_at_ms IS NULL OR (routed_at_ms >= 0 AND engine = 'claude'));

CREATE TRIGGER task_engine_is_fixed_after_first_run
BEFORE UPDATE OF engine ON task_metadata
WHEN NEW.engine IS NOT OLD.engine
  AND EXISTS (SELECT 1 FROM runs WHERE task_id = OLD.task_id)
BEGIN
  SELECT RAISE(ABORT, 'task_engine_fixed_after_first_run');
END;

CREATE TRIGGER task_routed_marker_is_sticky
BEFORE UPDATE OF routed_at_ms ON task_metadata
WHEN OLD.routed_at_ms IS NOT NULL AND NEW.routed_at_ms IS NOT OLD.routed_at_ms
BEGIN
  SELECT RAISE(ABORT, 'task_routed_marker_immutable');
END;

ALTER TABLE app_settings
ADD COLUMN claude_model TEXT NOT NULL DEFAULT ''
CHECK(claude_model = '' OR (
  length(claude_model) BETWEEN 1 AND 128
  AND claude_model GLOB '[A-Za-z0-9]*'
  AND claude_model NOT GLOB '*[^]A-Za-z0-9._:[-]*'
));

ALTER TABLE app_settings
ADD COLUMN claude_effort TEXT NOT NULL DEFAULT ''
CHECK(claude_effort = '' OR (
  length(claude_effort) BETWEEN 1 AND 32
  AND claude_effort GLOB '[a-z]*'
  AND claude_effort NOT GLOB '*[^a-z0-9_-]*'
));

ALTER TABLE app_settings
ADD COLUMN claude_permission_mode TEXT NOT NULL DEFAULT 'default'
CHECK(claude_permission_mode IN ('default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'));

CREATE TABLE task_runtime_settings_next (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
  model_id TEXT CHECK(model_id IS NULL OR (
    length(model_id) BETWEEN 1 AND 128
    AND model_id GLOB '[A-Za-z0-9]*'
    AND model_id NOT GLOB '*[^]A-Za-z0-9._:[-]*'
  )),
  reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR (
    length(reasoning_effort) BETWEEN 1 AND 32
    AND reasoning_effort GLOB '[a-z]*'
    AND reasoning_effort NOT GLOB '*[^a-z0-9_-]*'
  )),
  context_window INTEGER CHECK(context_window IS NULL OR context_window BETWEEN 1 AND 100000000),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO task_runtime_settings_next(
  task_id, model_id, reasoning_effort, context_window, revision, updated_at_ms
)
SELECT task_id, model_id, reasoning_effort, context_window, revision, updated_at_ms
FROM task_runtime_settings;

DROP TABLE task_runtime_settings;
ALTER TABLE task_runtime_settings_next RENAME TO task_runtime_settings;

CREATE TRIGGER task_runtime_model_follows_engine_on_insert
BEFORE INSERT ON task_runtime_settings
WHEN NEW.model_id IS NOT NULL
  AND (SELECT engine FROM task_metadata WHERE task_id = NEW.task_id) IS NOT 'claude'
  AND NOT (
    length(NEW.model_id) BETWEEN 1 AND 64
    AND NEW.model_id GLOB 'grok-*'
    AND NEW.model_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'task_runtime_model_engine_mismatch');
END;

CREATE TRIGGER task_runtime_model_follows_engine_on_update
BEFORE UPDATE OF model_id ON task_runtime_settings
WHEN NEW.model_id IS NOT NULL
  AND (SELECT engine FROM task_metadata WHERE task_id = NEW.task_id) IS NOT 'claude'
  AND NOT (
    length(NEW.model_id) BETWEEN 1 AND 64
    AND NEW.model_id GLOB 'grok-*'
    AND NEW.model_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'task_runtime_model_engine_mismatch');
END;

CREATE TABLE runtime_model_catalog_next (
  engine TEXT PRIMARY KEY CHECK(engine IN ('grok', 'claude')),
  catalog_json TEXT NOT NULL CHECK(length(catalog_json) BETWEEN 2 AND 262144),
  runtime_version TEXT CHECK(runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 128),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

INSERT INTO runtime_model_catalog_next(engine, catalog_json, runtime_version, updated_at_ms)
SELECT 'grok', catalog_json, runtime_version, updated_at_ms FROM runtime_model_catalog;

DROP TABLE runtime_model_catalog;
ALTER TABLE runtime_model_catalog_next RENAME TO runtime_model_catalog;

CREATE TABLE model_sources (
  source_id TEXT PRIMARY KEY CHECK(
    length(source_id) BETWEEN 1 AND 64
    AND source_id GLOB '[A-Za-z0-9]*'
    AND source_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  kind TEXT NOT NULL CHECK(kind IN ('online', 'local')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  base_url TEXT NOT NULL CHECK(
    length(base_url) BETWEEN 9 AND 2048
    AND base_url NOT GLOB '*[@?#]*'
    AND (
      (kind = 'online' AND base_url GLOB 'https://?*')
      OR (kind = 'local' AND (base_url GLOB 'https://?*' OR base_url GLOB 'http://?*'))
    )
  ),
  key_file TEXT CHECK(key_file IS NULL OR length(key_file) BETWEEN 1 AND 4096),
  key_variable TEXT CHECK(key_variable IS NULL OR (
    length(key_variable) BETWEEN 1 AND 64
    AND key_variable GLOB '[A-Z_]*'
    AND key_variable NOT GLOB '*[^A-Z0-9_]*'
  )),
  models_json TEXT NOT NULL CHECK(length(models_json) BETWEEN 2 AND 65536),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  confirmed_host TEXT CHECK(confirmed_host IS NULL OR (
    length(confirmed_host) BETWEEN 1 AND 300
    AND instr(base_url, confirmed_host) > 0
  )),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK(key_file IS NULL OR key_variable IS NOT NULL)
) STRICT;

CREATE TABLE workspace_prefs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  online_reminder_dismissed INTEGER NOT NULL CHECK(online_reminder_dismissed IN (0, 1))
) STRICT;

CREATE TABLE thinking_provenance (
  hash TEXT PRIMARY KEY CHECK(length(hash) BETWEEN 16 AND 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE INDEX thinking_provenance_by_created ON thinking_provenance(created_at_ms);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(19, 'dual_engine_and_model_sources', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

// Only a database created from scratch (user_version 0) runs this, inside the same transaction
// as MIGRATION_V16, so a new install follows the runtime default instead of the rewritten pair.
const MIGRATION_V16_FRESH_INSTALL = String.raw`
UPDATE app_settings SET grok_model = '', reasoning_effort = '';
`;

// V20 (Guild 3.0.2 UI polish: PC-CONV-001, PC-MODEL-001). Purely additive: one new table, no historical row is read
// or rewritten. run_model_labels holds, per Run, the display name of the model the Run started on (the name the
// picker showed: "Haiku 5.5", "DeepSeek V4 Flash"), written once after the engine applied the task's model selection
// and before the prompt went out, so the answer's footer can say which model answered and still can after a restart.
// A Run that started before this table existed has no row; its footer shows only the time.
const MIGRATION_V20 = String.raw`
CREATE TABLE guild_meta_next (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL CHECK(schema_version = 20),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
  last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
) STRICT;

INSERT INTO guild_meta_next(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
SELECT singleton, 20, clean_shutdown, last_integrity_at_ms FROM guild_meta;

DROP TABLE guild_meta;
ALTER TABLE guild_meta_next RENAME TO guild_meta;

CREATE TABLE run_model_labels (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 512),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(task_id, run_id),
  FOREIGN KEY(task_id, run_id) REFERENCES runs(task_id, run_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES(20, 'run_model_labels', CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

type IntegerRow = Record<string, unknown>;

function exactInteger(row: IntegerRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw persistenceError("schema_integrity_failed");
  }
  return value;
}

export function migrateSchema(database: DatabaseSync): void {
  let version = exactInteger(
    database.prepare("PRAGMA user_version").get(),
    "user_version",
  );
  if (version > SCHEMA_VERSION) {
    throw persistenceError("schema_version_unsupported");
  }
  const freshInstall = version === 0;
  if (version === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V1);
      database.exec("PRAGMA user_version = 1");
      database.exec("COMMIT");
      version = 1;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V2);
      database.exec("PRAGMA user_version = 2");
      database.exec("COMMIT");
      version = 2;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 2) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V3);
      database.exec("PRAGMA user_version = 3");
      database.exec("COMMIT");
      version = 3;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 3) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V4);
      database.exec("PRAGMA user_version = 4");
      database.exec("COMMIT");
      version = 4;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 4) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V5);
      database.exec("PRAGMA user_version = 5");
      database.exec("COMMIT");
      version = 5;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 5) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V6);
      database.exec("PRAGMA user_version = 6");
      database.exec("COMMIT");
      version = 6;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 6) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V7);
      database.exec("PRAGMA user_version = 7");
      database.exec("COMMIT");
      version = 7;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 7) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V8);
      database.exec("PRAGMA user_version = 8");
      database.exec("COMMIT");
      version = 8;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 8) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V9);
      database.exec("PRAGMA user_version = 9");
      database.exec("COMMIT");
      version = 9;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 9) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V10);
      database.exec("PRAGMA user_version = 10");
      database.exec("COMMIT");
      version = 10;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 10) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V11);
      database.exec("PRAGMA user_version = 11");
      database.exec("COMMIT");
      version = 11;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 11) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V12);
      database.exec("PRAGMA user_version = 12");
      database.exec("COMMIT");
      version = 12;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 12) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V13);
      database.exec("PRAGMA user_version = 13");
      database.exec("COMMIT");
      version = 13;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 13) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V14);
      database.exec("PRAGMA user_version = 14");
      database.exec("COMMIT");
      version = 14;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 14) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V15);
      database.exec("PRAGMA user_version = 15");
      database.exec("COMMIT");
      version = 15;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 15) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V16);
      if (freshInstall) database.exec(MIGRATION_V16_FRESH_INSTALL);
      database.exec("PRAGMA user_version = 16");
      database.exec("COMMIT");
      version = 16;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 16) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V17);
      database.exec("PRAGMA user_version = 17");
      database.exec("COMMIT");
      version = 17;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 17) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V18);
      database.exec("PRAGMA user_version = 18");
      database.exec("COMMIT");
      version = 18;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 18) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V19);
      database.exec("PRAGMA user_version = 19");
      database.exec("COMMIT");
      version = 19;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version === 19) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_V20);
      database.exec("PRAGMA user_version = 20");
      database.exec("COMMIT");
      version = 20;
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw persistenceError("schema_integrity_failed", cause);
    }
  }
  if (version !== SCHEMA_VERSION) {
    throw persistenceError("schema_integrity_failed");
  }
  const migrations = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all();
  const meta = database
    .prepare("SELECT schema_version FROM guild_meta WHERE singleton = 1")
    .get();
  if (
    migrations.length !== 20 ||
    exactInteger(migrations[0], "version") !== 1 ||
    migrations[0]?.["name"] !== "initial_authoritative_aggregates" ||
    exactInteger(migrations[1], "version") !== 2 ||
    migrations[1]?.["name"] !== "workspace_conversation_and_settings" ||
    exactInteger(migrations[2], "version") !== 3 ||
    migrations[2]?.["name"] !== "durable_queued_turns" ||
    exactInteger(migrations[3], "version") !== 4 ||
    migrations[3]?.["name"] !== "reversible_archives" ||
    exactInteger(migrations[4], "version") !== 5 ||
    migrations[4]?.["name"] !== "official_grok_runtime_settings" ||
    exactInteger(migrations[5], "version") !== 6 ||
    migrations[5]?.["name"] !== "profile_and_general_settings" ||
    exactInteger(migrations[6], "version") !== 7 ||
    migrations[6]?.["name"] !== "official_grok_permission_mode" ||
    exactInteger(migrations[7], "version") !== 8 ||
    migrations[7]?.["name"] !== "official_session_context_capacity" ||
    exactInteger(migrations[8], "version") !== 9 ||
    migrations[8]?.["name"] !== "pinned_conversations" ||
    exactInteger(migrations[9], "version") !== 10 ||
    migrations[9]?.["name"] !== "background_task_notifications" ||
    exactInteger(migrations[10], "version") !== 11 ||
    migrations[10]?.["name"] !== "all_official_permission_modes" ||
    exactInteger(migrations[11], "version") !== 12 ||
    migrations[11]?.["name"] !== "queued_turn_priorities" ||
    exactInteger(migrations[12], "version") !== 13 ||
    migrations[12]?.["name"] !== "continuous_task_controller" ||
    exactInteger(migrations[13], "version") !== 14 ||
    migrations[13]?.["name"] !== "readd_empty_deleted_workspaces" ||
    exactInteger(migrations[14], "version") !== 15 ||
    migrations[14]?.["name"] !== "streaming_write_path_and_context_usage" ||
    exactInteger(migrations[15], "version") !== 16 ||
    migrations[15]?.["name"] !== "runtime_model_catalog_and_task_settings" ||
    exactInteger(migrations[16], "version") !== 17 ||
    migrations[16]?.["name"] !== "steer_interjections_and_run_checkpoints" ||
    exactInteger(migrations[17], "version") !== 18 ||
    migrations[17]?.["name"] !== "task_worktrees" ||
    exactInteger(migrations[18], "version") !== 19 ||
    migrations[18]?.["name"] !== "dual_engine_and_model_sources" ||
    exactInteger(migrations[19], "version") !== 20 ||
    migrations[19]?.["name"] !== "run_model_labels" ||
    exactInteger(meta, "schema_version") !== SCHEMA_VERSION
  ) {
    throw persistenceError("schema_integrity_failed");
  }
}
