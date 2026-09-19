import type { DatabaseSync } from "node:sqlite";
import { persistenceError } from "./errors.js";

export const SCHEMA_VERSION = 14;

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
    migrations.length !== 14 ||
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
    exactInteger(meta, "schema_version") !== SCHEMA_VERSION
  ) {
    throw persistenceError("schema_integrity_failed");
  }
}
