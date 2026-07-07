CREATE TABLE IF NOT EXISTS ip_report_counts (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  count INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  minute_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_ip_report_counts_updated_at ON ip_report_counts(updated_at);
