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
) VALUES
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 4, 12, 11, 1, 8, 3, 1, 0, 0, 0, 11, 0, 1, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 3, 9, 9, 0, 6, 3, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 2, 8, 6, 2, 3, 2, 2, 1, 0, 0, 6, 2, 0, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 1, 10, 8, 2, 4, 4, 2, 0, 0, 0, 8, 0, 0, 1, 0, 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER), 14, 14, 0, 11, 3, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

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
) VALUES
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 4, 'sonnet', 8, 7, 1, 5, 2, 1, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 4, 'opus', 4, 4, 0, 3, 1, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 3, 'sonnet', 5, 5, 0, 3, 2, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 3, 'haiku', 4, 4, 0, 3, 1, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 2, 'opus', 5, 3, 2, 1, 1, 2, 1, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 2, 'sonnet', 3, 3, 0, 2, 1, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 1, 'sonnet', 6, 5, 1, 2, 2, 2, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 1, 'opus', 4, 3, 1, 2, 2, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER), 'sonnet', 10, 10, 0, 8, 2, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER), 'haiku', 4, 4, 0, 3, 1, 0, 0, 0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

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
) VALUES
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 4, 'sonnet', 'rate_limited', '429', 429, 'API Error 429: rate limit reached', 'API Error 429: rate limit reached', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('anyrouter.top', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 2, 'opus', 'server_error', '503', 503, 'Service overloaded', 'Service overloaded', 2, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 1, 'sonnet', 'network_error', 'none', NULL, 'Connection reset by peer', 'Connection reset by peer', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('a-ocnfniawgw.cn-shanghai.fcapp.run', CAST(CAST(strftime('%s', 'now') AS INTEGER) / 60 AS INTEGER) - 1, 'opus', 'timeout', 'none', NULL, 'Request timed out', 'Request timed out', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
