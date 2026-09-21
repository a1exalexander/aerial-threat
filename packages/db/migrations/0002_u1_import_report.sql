-- 0002 (unit 1): per-run import report next to the counters: quarantined (invalid) records with reasons,
-- unsupported records and replies whose parent is missing. Record positions only, no message text.
ALTER TABLE import_runs ADD COLUMN report jsonb NOT NULL DEFAULT '{}'::jsonb;
