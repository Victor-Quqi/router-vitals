ALTER TABLE samples_raw ADD COLUMN error_status_code INTEGER;
ALTER TABLE samples_raw ADD COLUMN error_hint TEXT;

CREATE TABLE IF NOT EXISTS error_observations (
  minute INTEGER NOT NULL,
  error_type TEXT NOT NULL,
  status_key TEXT NOT NULL,
  status_code INTEGER,
  hint_key TEXT NOT NULL,
  error_hint TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (minute, error_type, status_key, hint_key)
);

CREATE INDEX IF NOT EXISTS idx_error_observations_minute ON error_observations(minute);
