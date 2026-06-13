CREATE TABLE IF NOT EXISTS samples_raw (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error_type TEXT NOT NULL,
  model_class TEXT NOT NULL,
  latency_bucket TEXT NOT NULL,
  time_bucket INTEGER NOT NULL,
  plugin_version TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  sample_rate REAL NOT NULL,
  target_matched INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_samples_raw_created_at ON samples_raw(created_at);
CREATE INDEX IF NOT EXISTS idx_samples_raw_minute ON samples_raw(minute);
CREATE INDEX IF NOT EXISTS idx_samples_raw_anonymous_id ON samples_raw(anonymous_id);

CREATE TABLE IF NOT EXISTS minute_aggregates (
  minute INTEGER PRIMARY KEY,
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
  updated_at INTEGER NOT NULL
);
