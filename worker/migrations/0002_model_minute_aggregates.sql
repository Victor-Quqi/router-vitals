CREATE TABLE IF NOT EXISTS model_minute_aggregates (
  minute INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  total_samples INTEGER NOT NULL DEFAULT 0,
  success_samples INTEGER NOT NULL DEFAULT 0,
  failure_samples INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (minute, model_class)
);

CREATE INDEX IF NOT EXISTS idx_model_minute_aggregates_minute ON model_minute_aggregates(minute);

INSERT OR IGNORE INTO model_minute_aggregates (
  minute, model_class, total_samples, success_samples, failure_samples, updated_at
)
SELECT
  minute,
  model_class,
  COUNT(*),
  SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),
  MAX(created_at)
FROM samples_raw
GROUP BY minute, model_class;
