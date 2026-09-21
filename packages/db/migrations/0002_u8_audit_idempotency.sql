-- 0002 (unit 8): idempotent operator commands. A retry with the same idempotency_key returns the
-- stored response; a different request under the same key is detected by request_hash and rejected.
ALTER TABLE audit_log ADD COLUMN request_hash text;
ALTER TABLE audit_log ADD COLUMN response jsonb;
