DROP TABLE IF EXISTS preview_model_seed;

CREATE TABLE preview_model_seed (
  target_host TEXT NOT NULL,
  client TEXT NOT NULL,
  minute INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  total_samples INTEGER NOT NULL,
  success_samples INTEGER NOT NULL,
  failure_samples INTEGER NOT NULL,
  assistant_start_lt_3s INTEGER NOT NULL,
  assistant_start_3_10s INTEGER NOT NULL,
  assistant_start_10_30s INTEGER NOT NULL,
  assistant_start_30_60s INTEGER NOT NULL,
  assistant_start_gt_60s INTEGER NOT NULL,
  assistant_start_unknown INTEGER NOT NULL,
  err_server_error INTEGER NOT NULL,
  err_rate_limited INTEGER NOT NULL,
  err_network_error INTEGER NOT NULL,
  err_auth_error INTEGER NOT NULL,
  err_timeout INTEGER NOT NULL,
  err_unknown INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE preview_seed_rows (
  target_host TEXT NOT NULL,
  client TEXT NOT NULL,
  minute_offset INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  total_samples INTEGER NOT NULL,
  success_samples INTEGER NOT NULL,
  failure_samples INTEGER NOT NULL,
  lt_3s INTEGER NOT NULL,
  s_3_10s INTEGER NOT NULL,
  s_10_30s INTEGER NOT NULL,
  s_30_60s INTEGER NOT NULL,
  gt_60s INTEGER NOT NULL,
  start_unknown INTEGER NOT NULL,
  err_server_error INTEGER NOT NULL,
  err_rate_limited INTEGER NOT NULL,
  err_network_error INTEGER NOT NULL,
  err_auth_error INTEGER NOT NULL,
  err_timeout INTEGER NOT NULL,
  err_unknown INTEGER NOT NULL
);

INSERT INTO preview_seed_rows VALUES
  ('anyrouter.top', 'claude-code', -55, 'fable', 4, 4, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -45, 'fable', 9, 9, 0, 3, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -35, 'fable', 10, 8, 2, 2, 3, 2, 1, 0, 0, 2, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -25, 'fable', 5, 0, 5, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 2, 0),
  ('anyrouter.top', 'claude-code', -15, 'fable', 8, 6, 2, 1, 3, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0),
  ('anyrouter.top', 'claude-code', -5, 'fable', 11, 11, 0, 4, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -50, 'opus', 7, 5, 2, 1, 2, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -40, 'opus', 6, 6, 0, 1, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -30, 'opus', 6, 0, 6, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 0),
  ('anyrouter.top', 'claude-code', -10, 'opus', 10, 8, 2, 1, 3, 3, 1, 0, 0, 0, 1, 0, 0, 1, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', 0, 'opus', 8, 6, 2, 0, 2, 2, 1, 1, 0, 0, 0, 1, 0, 1, 0),
  ('anyrouter.top', 'claude-code', -55, 'sonnet', 15, 15, 0, 5, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -45, 'sonnet', 13, 10, 3, 3, 4, 2, 1, 0, 0, 1, 2, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -35, 'sonnet', 18, 18, 0, 6, 8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -20, 'sonnet', 12, 7, 5, 2, 3, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0),
  ('anyrouter.top', 'claude-code', -10, 'sonnet', 16, 16, 0, 5, 8, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0);

INSERT INTO preview_seed_rows VALUES
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', 0, 'sonnet', 14, 11, 3, 3, 5, 2, 1, 0, 0, 0, 2, 0, 0, 1, 0),
  ('anyrouter.top', 'claude-code', -50, 'haiku', 7, 7, 0, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -35, 'haiku', 6, 6, 0, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -20, 'haiku', 6, 4, 2, 3, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -5, 'haiku', 8, 8, 0, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'codex', -45, 'gpt-5.5', 11, 10, 1, 3, 5, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -30, 'gpt-5.5', 10, 7, 3, 1, 3, 2, 1, 0, 0, 0, 1, 1, 0, 1, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -15, 'gpt-5.5', 5, 0, 5, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 1),
  ('anyrouter.top', 'codex', -5, 'gpt-5.5', 12, 10, 2, 2, 5, 2, 1, 0, 0, 0, 1, 0, 0, 1, 0),
  ('anyrouter.top', 'codex', 0, 'gpt-5.5', 9, 9, 0, 2, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -40, 'unknown', 3, 2, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -10, 'unknown', 4, 2, 2, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1),
  ('anyrouter.top', 'codex', -120, 'gpt-5.5', 18, 16, 2, 4, 8, 3, 1, 0, 0, 0, 1, 0, 0, 1, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -185, 'sonnet', 24, 22, 2, 7, 10, 4, 1, 0, 0, 1, 1, 0, 0, 0, 0),
  ('anyrouter.top', 'claude-code', -260, 'opus', 11, 9, 2, 2, 4, 2, 1, 0, 0, 1, 0, 0, 0, 1, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -390, 'gpt-5.5', 15, 9, 6, 2, 4, 2, 1, 0, 0, 1, 2, 1, 0, 1, 1);

INSERT INTO preview_seed_rows VALUES
  ('anyrouter.top', 'claude-code', -515, 'fable', 14, 13, 1, 5, 6, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -760, 'haiku', 9, 9, 0, 7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'codex', -1025, 'gpt-5.5', 12, 10, 2, 3, 5, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -1315, 'opus', 10, 3, 7, 0, 1, 1, 1, 0, 0, 2, 1, 1, 1, 2, 0),
  ('anyrouter.top', 'claude-code', -1700, 'fable', 20, 19, 1, 7, 9, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -2260, 'gpt-5.5', 16, 12, 4, 3, 5, 3, 1, 0, 0, 1, 1, 1, 0, 1, 0),
  ('anyrouter.top', 'claude-code', -3100, 'sonnet', 28, 25, 3, 8, 12, 4, 1, 0, 0, 2, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -4200, 'haiku', 13, 13, 0, 10, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ('anyrouter.top', 'codex', -6100, 'gpt-5.5', 19, 18, 1, 5, 9, 3, 1, 0, 0, 0, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -8450, 'sonnet', 22, 18, 4, 5, 8, 4, 1, 0, 0, 1, 2, 0, 0, 1, 0),
  ('anyrouter.top', 'claude-code', -12500, 'opus', 16, 14, 2, 3, 6, 4, 1, 0, 0, 1, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'codex', -18400, 'gpt-5.5', 14, 5, 9, 1, 2, 1, 0, 1, 0, 2, 1, 2, 1, 2, 1),
  ('anyrouter.top', 'claude-code', -26200, 'fable', 18, 17, 1, 6, 8, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', 'claude-code', -35500, 'sonnet', 24, 21, 3, 6, 10, 4, 1, 0, 0, 1, 1, 0, 0, 1, 0),
  ('anyrouter.top', 'codex', -39900, 'gpt-5.5', 15, 14, 1, 4, 7, 2, 1, 0, 0, 0, 1, 0, 0, 0, 0);

INSERT INTO preview_model_seed (
  target_host,
  client,
  minute,
  model_class,
  total_samples,
  success_samples,
  failure_samples,
  assistant_start_lt_3s,
  assistant_start_3_10s,
  assistant_start_10_30s,
  assistant_start_30_60s,
  assistant_start_gt_60s,
  assistant_start_unknown,
  err_server_error,
  err_rate_limited,
  err_network_error,
  err_auth_error,
  err_timeout,
  err_unknown,
  updated_at
)
WITH now_value(now_minute, updated_at) AS (
  SELECT
    CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
SELECT
  preview_seed_rows.target_host,
  preview_seed_rows.client,
  now_value.now_minute + preview_seed_rows.minute_offset,
  preview_seed_rows.model_class,
  preview_seed_rows.total_samples,
  preview_seed_rows.success_samples,
  preview_seed_rows.failure_samples,
  preview_seed_rows.lt_3s,
  preview_seed_rows.s_3_10s,
  preview_seed_rows.s_10_30s,
  preview_seed_rows.s_30_60s,
  preview_seed_rows.gt_60s,
  preview_seed_rows.start_unknown,
  preview_seed_rows.err_server_error,
  preview_seed_rows.err_rate_limited,
  preview_seed_rows.err_network_error,
  preview_seed_rows.err_auth_error,
  preview_seed_rows.err_timeout,
  preview_seed_rows.err_unknown,
  now_value.updated_at
FROM now_value
CROSS JOIN preview_seed_rows;

INSERT INTO target_minute_aggregates (
  target_host,
  client,
  minute,
  total_samples,
  success_samples,
  failure_samples,
  assistant_start_lt_3s,
  assistant_start_3_10s,
  assistant_start_10_30s,
  assistant_start_30_60s,
  assistant_start_gt_60s,
  assistant_start_unknown,
  err_none,
  err_server_error,
  err_rate_limited,
  err_network_error,
  err_auth_error,
  err_timeout,
  err_unknown,
  updated_at
)
SELECT
  target_host,
  client,
  minute,
  SUM(total_samples),
  SUM(success_samples),
  SUM(failure_samples),
  SUM(assistant_start_lt_3s),
  SUM(assistant_start_3_10s),
  SUM(assistant_start_10_30s),
  SUM(assistant_start_30_60s),
  SUM(assistant_start_gt_60s),
  SUM(assistant_start_unknown),
  SUM(success_samples),
  SUM(err_server_error),
  SUM(err_rate_limited),
  SUM(err_network_error),
  SUM(err_auth_error),
  SUM(err_timeout),
  SUM(err_unknown),
  MAX(updated_at)
FROM preview_model_seed
GROUP BY target_host, client, minute;

INSERT INTO target_model_minute_aggregates (
  target_host,
  client,
  minute,
  model_class,
  total_samples,
  success_samples,
  failure_samples,
  assistant_start_lt_3s,
  assistant_start_3_10s,
  assistant_start_10_30s,
  assistant_start_30_60s,
  assistant_start_gt_60s,
  assistant_start_unknown,
  updated_at
)
SELECT
  target_host,
  client,
  minute,
  model_class,
  total_samples,
  success_samples,
  failure_samples,
  assistant_start_lt_3s,
  assistant_start_3_10s,
  assistant_start_10_30s,
  assistant_start_30_60s,
  assistant_start_gt_60s,
  assistant_start_unknown,
  updated_at
FROM preview_model_seed;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'server_error', '503', 503, 'Service overloaded', 'Service overloaded', err_server_error, updated_at
FROM preview_model_seed
WHERE err_server_error > 0;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'rate_limited', '429', 429, 'API Error 429: rate limit reached', 'API Error 429: rate limit reached', err_rate_limited, updated_at
FROM preview_model_seed
WHERE err_rate_limited > 0;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'network_error', 'none', NULL, 'fetch failed: connection reset', 'fetch failed: connection reset', err_network_error, updated_at
FROM preview_model_seed
WHERE err_network_error > 0;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'auth_error', '401', 401, 'Unauthorized: invalid API key', 'Unauthorized: invalid API key', err_auth_error, updated_at
FROM preview_model_seed
WHERE err_auth_error > 0;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'timeout', '504', 504, 'Request timed out after 60s', 'Request timed out after 60s', err_timeout, updated_at
FROM preview_model_seed
WHERE err_timeout > 0;

INSERT INTO target_model_error_observations (
  target_host,
  client,
  minute,
  model_class,
  error_type,
  status_key,
  status_code,
  hint_key,
  error_hint,
  count,
  updated_at
)
SELECT target_host, client, minute, model_class, 'unknown', 'none', NULL, 'No assistant response before process exit', 'No assistant response before process exit', err_unknown, updated_at
FROM preview_model_seed
WHERE err_unknown > 0;

DROP TABLE preview_seed_rows;
DROP TABLE preview_model_seed;
