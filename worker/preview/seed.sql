DROP TABLE IF EXISTS preview_model_seed;

CREATE TABLE preview_model_seed (
  target_host TEXT NOT NULL,
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

INSERT INTO preview_model_seed (
  target_host,
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
WITH
  now_value(now_minute, updated_at) AS (
    SELECT
      CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER),
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  seed_rows(target_host, minute_offset, model_class, total_samples, success_samples, failure_samples, lt_3s, s_3_10s, s_10_30s, error_type) AS (
    VALUES
      ('anyrouter.top', -55, 'fable', 3, 3, 0, 2, 1, 0, NULL),
      ('anyrouter.top', -50, 'fable', 1, 0, 1, 0, 0, 0, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -45, 'fable', 4, 4, 0, 2, 2, 0, NULL),
      ('anyrouter.top', -35, 'fable', 5, 4, 1, 2, 1, 1, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -20, 'fable', 3, 3, 0, 1, 2, 0, NULL),
      ('anyrouter.top', -15, 'fable', 1, 0, 1, 0, 0, 0, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -5, 'fable', 4, 4, 0, 2, 2, 0, NULL),
      ('anyrouter.top', 0, 'fable', 5, 4, 1, 2, 2, 0, 'rate_limited'),

      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -55, 'opus', 1, 0, 1, 0, 0, 0, 'server_error'),
      ('anyrouter.top', -45, 'opus', 4, 3, 1, 1, 1, 1, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -40, 'opus', 3, 3, 0, 1, 1, 1, NULL),
      ('anyrouter.top', -30, 'opus', 2, 2, 0, 1, 1, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -25, 'opus', 1, 0, 1, 0, 0, 0, 'rate_limited'),
      ('anyrouter.top', -10, 'opus', 5, 4, 1, 1, 2, 1, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -5, 'opus', 4, 4, 0, 1, 2, 1, NULL),

      ('anyrouter.top', -50, 'sonnet', 7, 7, 0, 3, 4, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -45, 'sonnet', 5, 4, 1, 2, 2, 0, 'rate_limited'),
      ('anyrouter.top', -35, 'sonnet', 8, 8, 0, 3, 4, 1, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -30, 'sonnet', 1, 0, 1, 0, 0, 0, 'server_error'),
      ('anyrouter.top', -25, 'sonnet', 6, 6, 0, 2, 4, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -15, 'sonnet', 7, 6, 1, 2, 3, 1, 'server_error'),
      ('anyrouter.top', -10, 'sonnet', 5, 5, 0, 2, 3, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', 0, 'sonnet', 6, 5, 1, 2, 3, 0, 'rate_limited'),

      ('anyrouter.top', -55, 'haiku', 2, 2, 0, 2, 0, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -40, 'haiku', 1, 0, 1, 0, 0, 0, 'rate_limited'),
      ('anyrouter.top', -30, 'haiku', 3, 3, 0, 2, 1, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -20, 'haiku', 2, 2, 0, 1, 1, 0, NULL),
      ('anyrouter.top', -15, 'haiku', 2, 1, 1, 1, 0, 0, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -5, 'haiku', 3, 3, 0, 2, 1, 0, NULL),

      ('anyrouter.top', -120, 'fable', 8, 7, 1, 4, 3, 0, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -185, 'sonnet', 12, 12, 0, 5, 6, 1, NULL),
      ('anyrouter.top', -260, 'opus', 6, 5, 1, 2, 2, 1, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -390, 'haiku', 5, 5, 0, 4, 1, 0, NULL),
      ('anyrouter.top', -515, 'sonnet', 10, 8, 2, 3, 4, 1, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -760, 'fable', 7, 7, 0, 4, 3, 0, NULL),
      ('anyrouter.top', -1025, 'opus', 4, 0, 4, 0, 0, 0, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -1315, 'sonnet', 11, 10, 1, 4, 5, 1, 'rate_limited'),

      ('anyrouter.top', -1700, 'fable', 9, 9, 0, 5, 4, 0, NULL),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -2260, 'opus', 5, 4, 1, 1, 2, 1, 'rate_limited'),
      ('anyrouter.top', -3100, 'sonnet', 14, 12, 2, 5, 6, 1, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -4200, 'haiku', 6, 6, 0, 4, 2, 0, NULL),
      ('anyrouter.top', -6100, 'fable', 7, 6, 1, 3, 3, 0, 'server_error'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -8450, 'sonnet', 10, 10, 0, 4, 5, 1, NULL),
      ('anyrouter.top', -12500, 'opus', 8, 7, 1, 2, 3, 2, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -18400, 'haiku', 5, 0, 5, 0, 0, 0, 'server_error'),
      ('anyrouter.top', -26200, 'fable', 11, 10, 1, 4, 5, 1, 'rate_limited'),
      ('a-ocnfniawgw.cn-shanghai.fcapp.run', -35500, 'sonnet', 13, 13, 0, 5, 7, 1, NULL),
      ('anyrouter.top', -39900, 'opus', 4, 4, 0, 1, 2, 1, NULL)
  )
SELECT
  seed_rows.target_host,
  now_value.now_minute + seed_rows.minute_offset,
  seed_rows.model_class,
  seed_rows.total_samples,
  seed_rows.success_samples,
  seed_rows.failure_samples,
  seed_rows.lt_3s,
  seed_rows.s_3_10s,
  seed_rows.s_10_30s,
  0,
  0,
  0,
  CASE WHEN seed_rows.error_type = 'server_error' THEN seed_rows.failure_samples ELSE 0 END,
  CASE WHEN seed_rows.error_type = 'rate_limited' THEN seed_rows.failure_samples ELSE 0 END,
  0,
  0,
  0,
  0,
  now_value.updated_at
FROM now_value
CROSS JOIN seed_rows;

INSERT INTO target_minute_aggregates (
  target_host,
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
GROUP BY target_host, minute;

INSERT INTO target_model_minute_aggregates (
  target_host,
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
SELECT target_host, minute, model_class, 'server_error', '503', 503, 'Service overloaded', 'Service overloaded', err_server_error, updated_at
FROM preview_model_seed
WHERE err_server_error > 0
UNION ALL
SELECT target_host, minute, model_class, 'rate_limited', '429', 429, 'API Error 429: rate limit reached', 'API Error 429: rate limit reached', err_rate_limited, updated_at
FROM preview_model_seed
WHERE err_rate_limited > 0;

DROP TABLE preview_model_seed;
