CREATE TABLE IF NOT EXISTS model_error_observations (
  minute INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  error_type TEXT NOT NULL,
  status_key TEXT NOT NULL,
  status_code INTEGER,
  hint_key TEXT NOT NULL,
  error_hint TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (minute, model_class, error_type, status_key, hint_key)
);

CREATE INDEX IF NOT EXISTS idx_model_error_observations_minute ON model_error_observations(minute);
CREATE INDEX IF NOT EXISTS idx_model_error_observations_model_minute ON model_error_observations(model_class, minute);

INSERT OR IGNORE INTO model_error_observations (
  minute, model_class, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
)
SELECT
  minute,
  model_class,
  error_type,
  CASE WHEN error_status_code IS NULL THEN 'none' ELSE CAST(error_status_code AS TEXT) END,
  error_status_code,
  CASE WHEN error_hint IS NULL OR error_hint = '' THEN 'none' ELSE error_hint END,
  CASE WHEN error_hint IS NULL OR error_hint = '' THEN NULL ELSE error_hint END,
  COUNT(*),
  MAX(created_at)
FROM samples_raw
WHERE ok = 0
GROUP BY
  minute,
  model_class,
  error_type,
  error_status_code,
  error_hint;
