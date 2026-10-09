-- One-off compaction of historical per-chunk stream envelopes (Guild <= 2.1.x wrote one
-- committed_envelopes row per streamed text/thought chunk). Run only while Guild is closed,
-- after a full backup, then VACUUM.
--
-- Kept: every non-chunk envelope (tools, plans, prompt_terminal used for legacy context
-- tokens), the max receive_sequence row per (task, adapter epoch) used by admission, and every
-- envelope of a Run that is not terminal. conversation_entries (the transcript) is untouched.
-- Startup verification checks rows one by one and never requires contiguous sequences.
--
-- Measured 2026-10-09 on a copy of the owner DB: 495,778 rows removed, 1.02 GB -> 390 MB,
-- integrity_check ok, unclean-start verification 9-20 s -> 2.4 s.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE keep_rows AS
  SELECT task_id, adapter_epoch, MAX(receive_sequence) AS seq
  FROM committed_envelopes GROUP BY task_id, adapter_epoch;
CREATE TEMP TABLE live_runs AS
  SELECT task_id, run_id FROM runs
  WHERE json_extract(snapshot_json, '$.state') NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'refused');
DELETE FROM committed_envelopes
WHERE json_extract(event_json, '$.payload.type') IN ('agent_text_chunk', 'agent_thought_chunk')
  AND NOT EXISTS (
    SELECT 1 FROM keep_rows k
    WHERE k.task_id = committed_envelopes.task_id
      AND k.adapter_epoch = committed_envelopes.adapter_epoch
      AND k.seq = committed_envelopes.receive_sequence)
  AND NOT EXISTS (
    SELECT 1 FROM live_runs r
    WHERE r.task_id = committed_envelopes.task_id
      AND r.run_id = json_extract(committed_envelopes.event_json, '$.envelope.runId'));
SELECT 'deleted', changes();
COMMIT;
