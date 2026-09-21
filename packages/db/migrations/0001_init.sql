-- 0001: initial schema (doc 03). Never edit once applied; add NNNN_<slug>.sql instead.
-- No `places` table: the dictionary is versioned code in @aerial/geo; place_id/area_id hold its stable IDs.

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  username text,
  display_name text,
  default_place_id text,
  enabled boolean NOT NULL DEFAULT true,
  trust_policy_version text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_provider_external_id_key ON sources (provider, external_id);

CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources (id),
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX import_runs_file_hash_idx ON import_runs (file_hash);

-- Telegram IDs are bigint in SQL and decimal strings in JS.
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources (id),
  external_message_id bigint NOT NULL,
  published_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  latest_revision_id uuid,
  reply_to_external_id bigint,
  deleted_at timestamptz,
  mode text NOT NULL,
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX messages_source_external_key ON messages (source_id, external_message_id);
CREATE INDEX messages_source_published_idx ON messages (source_id, published_at);

CREATE TABLE message_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages (id),
  revision_hash text NOT NULL,
  edited_at timestamptz,
  raw_payload jsonb,
  raw_text text NOT NULL,
  normalized_text text NOT NULL,
  cleaned_text text NOT NULL,
  media_flags text[] NOT NULL DEFAULT '{}'::text[],
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_revisions_message_hash_key ON message_revisions (message_id, revision_hash);

ALTER TABLE messages ADD CONSTRAINT messages_latest_revision_id_fkey
  FOREIGN KEY (latest_revision_id) REFERENCES message_revisions (id);

CREATE TABLE processing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES message_revisions (id),
  context_hash text NOT NULL,
  model text NOT NULL,
  questions_version text NOT NULL,
  parser_version text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL,
  latency_ms integer,
  usage jsonb,
  provider_request_id text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX processing_runs_key
  ON processing_runs (revision_id, context_hash, parser_version, questions_version, model, policy_version);

CREATE TABLE processing_dependencies (
  run_id uuid NOT NULL REFERENCES processing_runs (id),
  depends_on_revision_id uuid NOT NULL REFERENCES message_revisions (id),
  relation text NOT NULL,
  PRIMARY KEY (run_id, depends_on_revision_id)
);
CREATE INDEX processing_dependencies_revision_idx ON processing_dependencies (depends_on_revision_id);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES processing_runs (id),
  revision_id uuid NOT NULL REFERENCES message_revisions (id),
  ordinal integer NOT NULL DEFAULT 0,
  kind text NOT NULL,
  threat_type text NOT NULL,
  threat_qualifier jsonb,
  temporal_scope text NOT NULL,
  quantity integer,
  quantity_text text,
  place_id text,
  geo_basis text NOT NULL,
  movement_mention text,
  evidence jsonb NOT NULL,
  assessments jsonb NOT NULL DEFAULT '[]'::jsonb,
  publication_decision text NOT NULL,
  uncertainty jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_revision_idx ON claims (revision_id);
CREATE INDEX claims_run_idx ON claims (run_id);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  threat_type text,
  area_id text,
  mode text NOT NULL,
  lifecycle text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_evidence_at timestamptz NOT NULL,
  summary text,
  has_conflict boolean NOT NULL DEFAULT false,
  closure_claim_id uuid REFERENCES claims (id),
  revision integer NOT NULL DEFAULT 1,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_area_lifecycle_evidence_idx ON incidents (area_id, lifecycle, last_evidence_at);

CREATE TABLE incident_evidence (
  incident_id uuid NOT NULL REFERENCES incidents (id),
  claim_id uuid NOT NULL REFERENCES claims (id),
  relation text NOT NULL,
  origin_group text,
  reason text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, claim_id)
);
CREATE INDEX incident_evidence_claim_idx ON incident_evidence (claim_id);

CREATE TABLE alert_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  fetched_at timestamptz NOT NULL,
  provider_time timestamptz,
  payload_hash text NOT NULL,
  raw_payload jsonb,
  valid boolean NOT NULL,
  error text
);
CREATE INDEX alert_snapshots_provider_fetched_idx ON alert_snapshots (provider, fetched_at);

CREATE TABLE alert_states (
  area_key text PRIMARY KEY,
  area_kind text NOT NULL,
  place_id text,
  state text NOT NULL,
  level text,
  since timestamptz,
  freshness text NOT NULL,
  last_success_at timestamptz,
  last_provider_change_at timestamptz,
  snapshot_id uuid REFERENCES alert_snapshots (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_owner text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- One live job per logical unit of work; a done/dead key may be enqueued again.
CREATE UNIQUE INDEX jobs_dedupe_active_key ON jobs (dedupe_key) WHERE status IN ('queued', 'running', 'failed');
CREATE INDEX jobs_ready_idx ON jobs (status, priority DESC, next_attempt_at);

CREATE TABLE source_health (
  source_id uuid PRIMARY KEY REFERENCES sources (id),
  last_success_at timestamptz,
  last_message_at timestamptz,
  lag_ms integer,
  error_kind text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before jsonb,
  after jsonb,
  reason text NOT NULL,
  idempotency_key text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX audit_log_idempotency_key ON audit_log (idempotency_key);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
