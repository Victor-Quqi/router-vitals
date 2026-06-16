CREATE TABLE IF NOT EXISTS daily_report_counts (
  day TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, anonymous_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_report_counts_updated_at ON daily_report_counts(updated_at);
