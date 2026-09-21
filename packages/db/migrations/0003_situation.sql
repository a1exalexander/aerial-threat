-- 0003: situation snapshots of the Kremenchuk screen. One row per evaluation (AI or rules) of a window of recent
-- posts, with provenance. Revision IDs are plain uuid[] (no FK): a snapshot outlives retention scrubs of the text.
CREATE TABLE situation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  window_from timestamptz,
  window_to timestamptz,
  revision_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  relevant_revision_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  statuses jsonb NOT NULL,
  route jsonb,
  mode text NOT NULL,
  model text,
  questions_version text,
  rules_version text,
  usage jsonb,
  provider_request_id text,
  latency_ms integer,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX situation_snapshots_area_evaluated_idx ON situation_snapshots (area_id, evaluated_at DESC);
