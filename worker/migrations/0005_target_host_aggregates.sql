ALTER TABLE samples_raw ADD COLUMN target_host TEXT;

CREATE TABLE IF NOT EXISTS target_minute_aggregates (
  target_host TEXT NOT NULL,
  minute INTEGER NOT NULL,
  total_samples INTEGER NOT NULL DEFAULT 0,
  success_samples INTEGER NOT NULL DEFAULT 0,
  failure_samples INTEGER NOT NULL DEFAULT 0,
  latency_lt_3s INTEGER NOT NULL DEFAULT 0,
  latency_3_10s INTEGER NOT NULL DEFAULT 0,
  latency_10_30s INTEGER NOT NULL DEFAULT 0,
  latency_30_60s INTEGER NOT NULL DEFAULT 0,
  latency_gt_60s INTEGER NOT NULL DEFAULT 0,
  latency_unknown INTEGER NOT NULL DEFAULT 0,
  err_none INTEGER NOT NULL DEFAULT 0,
  err_server_error INTEGER NOT NULL DEFAULT 0,
  err_rate_limited INTEGER NOT NULL DEFAULT 0,
  err_network_error INTEGER NOT NULL DEFAULT 0,
  err_auth_error INTEGER NOT NULL DEFAULT 0,
  err_timeout INTEGER NOT NULL DEFAULT 0,
  err_unknown INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_host, minute)
);

CREATE INDEX IF NOT EXISTS idx_target_minute_aggregates_minute ON target_minute_aggregates(minute);

CREATE TABLE IF NOT EXISTS target_model_minute_aggregates (
  target_host TEXT NOT NULL,
  minute INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  total_samples INTEGER NOT NULL DEFAULT 0,
  success_samples INTEGER NOT NULL DEFAULT 0,
  failure_samples INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_host, minute, model_class)
);

CREATE INDEX IF NOT EXISTS idx_target_model_minute_aggregates_minute ON target_model_minute_aggregates(minute);
CREATE INDEX IF NOT EXISTS idx_target_model_minute_aggregates_model_minute ON target_model_minute_aggregates(target_host, model_class, minute);

CREATE TABLE IF NOT EXISTS target_error_observations (
  target_host TEXT NOT NULL,
  minute INTEGER NOT NULL,
  error_type TEXT NOT NULL,
  status_key TEXT NOT NULL,
  status_code INTEGER,
  hint_key TEXT NOT NULL,
  error_hint TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_host, minute, error_type, status_key, hint_key)
);

CREATE INDEX IF NOT EXISTS idx_target_error_observations_minute ON target_error_observations(minute);

CREATE TABLE IF NOT EXISTS target_model_error_observations (
  target_host TEXT NOT NULL,
  minute INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  error_type TEXT NOT NULL,
  status_key TEXT NOT NULL,
  status_code INTEGER,
  hint_key TEXT NOT NULL,
  error_hint TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_host, minute, model_class, error_type, status_key, hint_key)
);

CREATE INDEX IF NOT EXISTS idx_target_model_error_observations_minute ON target_model_error_observations(minute);
CREATE INDEX IF NOT EXISTS idx_target_model_error_observations_model_minute ON target_model_error_observations(target_host, model_class, minute);

DROP TABLE IF EXISTS minute_aggregates;
DROP TABLE IF EXISTS model_minute_aggregates;
DROP TABLE IF EXISTS error_observations;
DROP TABLE IF EXISTS model_error_observations;
