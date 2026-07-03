import { SERVER_DAILY_REPORT_HARD_LIMIT, SERVER_DAILY_REPORT_SOFT_LIMIT, STATUS_ASSISTANT_START_COLUMNS } from "../../shared/policy.mjs";
const ASSISTANT_START_COLUMNS = Object.freeze(Object.fromEntries(STATUS_ASSISTANT_START_COLUMNS));
const ERROR_COLUMNS = Object.freeze({
    none: "err_none",
    server_error: "err_server_error",
    rate_limited: "err_rate_limited",
    network_error: "err_network_error",
    auth_error: "err_auth_error",
    timeout: "err_timeout",
    unknown: "err_unknown"
});
const MAX_RETENTION_DAYS = 90;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
export function createSqlReportStore(db) {
    return {
        reserveDailyReportSlot(anonymousId, nowMs) {
            return reserveDailyReportSlot(db, anonymousId, nowMs);
        },
        recordReport(record) {
            return recordReport(db, record);
        },
        queryAggregates(sinceMinute, targetHost) {
            return queryAggregates(db, sinceMinute, targetHost);
        },
        queryModelAggregates(sinceMinute, targetHost) {
            return queryModelAggregates(db, sinceMinute, targetHost);
        },
        queryModelErrorDetails(sinceMinute, nowMinute, bucketMinutes, targetHost) {
            return queryModelErrorDetails(db, sinceMinute, nowMinute, bucketMinutes, targetHost);
        },
        purgeExpiredData(nowMs, options = {}) {
            return purgeExpiredData(db, nowMs, options);
        }
    };
}
async function recordReport(db, { payload, nowMs, minute, targetHost }) {
    const statements = [
        createTargetAggregateStatement(db, payload, nowMs, minute, targetHost),
        createTargetModelAggregateStatement(db, payload, nowMs, minute, targetHost)
    ];
    if (!payload.ok)
        statements.push(createTargetModelErrorObservationStatement(db, payload, nowMs, minute, targetHost));
    await db.batch(statements);
}
function createTargetAggregateStatement(db, payload, nowMs, minute, targetHost) {
    const assistantStartColumn = ASSISTANT_START_COLUMNS[payload.assistantStartBucket] || ASSISTANT_START_COLUMNS.unknown;
    const errorColumn = ERROR_COLUMNS[payload.errorType] || ERROR_COLUMNS.unknown;
    const successDelta = payload.ok ? 1 : 0;
    const failureDelta = payload.ok ? 0 : 1;
    const assistantStartDelta = payload.ok ? 1 : 0;
    return db.prepare(`
    INSERT INTO target_minute_aggregates (
      target_host, client, minute, total_samples, success_samples, failure_samples, ${assistantStartColumn}, ${errorColumn}, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?)
    ON CONFLICT(target_host, minute, client) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      ${assistantStartColumn} = ${assistantStartColumn} + ?,
      ${errorColumn} = ${errorColumn} + 1,
      updated_at = ?
  `).bind(targetHost, payload.client, minute, successDelta, failureDelta, assistantStartDelta, nowMs, successDelta, failureDelta, assistantStartDelta, nowMs);
}
function createTargetModelAggregateStatement(db, payload, nowMs, minute, targetHost) {
    const assistantStartColumn = ASSISTANT_START_COLUMNS[payload.assistantStartBucket] || ASSISTANT_START_COLUMNS.unknown;
    const successDelta = payload.ok ? 1 : 0;
    const failureDelta = payload.ok ? 0 : 1;
    const assistantStartDelta = payload.ok ? 1 : 0;
    return db.prepare(`
    INSERT INTO target_model_minute_aggregates (
      target_host, client, minute, model_class, total_samples, success_samples, failure_samples, ${assistantStartColumn}, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(target_host, minute, model_class, client) DO UPDATE SET
      total_samples = total_samples + 1,
      success_samples = success_samples + ?,
      failure_samples = failure_samples + ?,
      ${assistantStartColumn} = ${assistantStartColumn} + ?,
      updated_at = ?
  `).bind(targetHost, payload.client, minute, payload.modelClass, successDelta, failureDelta, assistantStartDelta, nowMs, successDelta, failureDelta, assistantStartDelta, nowMs);
}
function createTargetModelErrorObservationStatement(db, payload, nowMs, minute, targetHost) {
    const statusCode = payload.errorStatusCode ?? null;
    const errorHint = payload.errorHint || null;
    const statusKey = statusCode === null ? "none" : String(statusCode);
    const hintKey = errorHint || "none";
    return db.prepare(`
    INSERT INTO target_model_error_observations (
      target_host, client, minute, model_class, error_type, status_key, status_code, hint_key, error_hint, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(target_host, minute, model_class, client, error_type, status_key, hint_key) DO UPDATE SET
      count = count + 1,
      updated_at = ?
  `).bind(targetHost, payload.client, minute, payload.modelClass, payload.errorType, statusKey, statusCode, hintKey, errorHint, nowMs, nowMs);
}
async function queryAggregates(db, sinceMinute, targetHost) {
    const selectColumns = `
    minute,
    SUM(total_samples) AS total_samples,
    SUM(success_samples) AS success_samples,
    SUM(failure_samples) AS failure_samples,
    SUM(assistant_start_lt_3s) AS assistant_start_lt_3s,
    SUM(assistant_start_3_10s) AS assistant_start_3_10s,
    SUM(assistant_start_10_30s) AS assistant_start_10_30s,
    SUM(assistant_start_30_60s) AS assistant_start_30_60s,
    SUM(assistant_start_gt_60s) AS assistant_start_gt_60s,
    SUM(assistant_start_unknown) AS assistant_start_unknown,
    SUM(err_none) AS err_none,
    SUM(err_server_error) AS err_server_error,
    SUM(err_rate_limited) AS err_rate_limited,
    SUM(err_network_error) AS err_network_error,
    SUM(err_auth_error) AS err_auth_error,
    SUM(err_timeout) AS err_timeout,
    SUM(err_unknown) AS err_unknown
  `;
    if (!targetHost) {
        return db
            .prepare(`
        SELECT ${selectColumns}
        FROM target_minute_aggregates
        WHERE minute >= ?
        GROUP BY minute
        ORDER BY minute ASC
      `)
            .bind(sinceMinute)
            .all();
    }
    return db
        .prepare(`
      SELECT ${selectColumns}
      FROM target_minute_aggregates
      WHERE target_host = ? AND minute >= ?
      GROUP BY minute
      ORDER BY minute ASC
    `)
        .bind(targetHost, sinceMinute)
        .all();
}
async function queryModelAggregates(db, sinceMinute, targetHost) {
    const selectColumns = `
    minute,
    model_class,
    SUM(total_samples) AS total_samples,
    SUM(success_samples) AS success_samples,
    SUM(failure_samples) AS failure_samples,
    SUM(assistant_start_lt_3s) AS assistant_start_lt_3s,
    SUM(assistant_start_3_10s) AS assistant_start_3_10s,
    SUM(assistant_start_10_30s) AS assistant_start_10_30s,
    SUM(assistant_start_30_60s) AS assistant_start_30_60s,
    SUM(assistant_start_gt_60s) AS assistant_start_gt_60s,
    SUM(assistant_start_unknown) AS assistant_start_unknown
  `;
    if (!targetHost) {
        return db
            .prepare(`
        SELECT ${selectColumns}
        FROM target_model_minute_aggregates
        WHERE minute >= ?
        GROUP BY minute, model_class
        ORDER BY minute ASC, model_class ASC
      `)
            .bind(sinceMinute)
            .all();
    }
    return db
        .prepare(`
      SELECT ${selectColumns}
      FROM target_model_minute_aggregates
      WHERE target_host = ? AND minute >= ?
      GROUP BY minute, model_class
      ORDER BY minute ASC, model_class ASC
    `)
        .bind(targetHost, sinceMinute)
        .all();
}
async function queryModelErrorDetails(db, sinceMinute, nowMinute, bucketMinutes, targetHost) {
    if (!targetHost) {
        return db
            .prepare(`
        SELECT bucket_index, model_class, error_type, status_code, error_hint, SUM(count) AS count
        FROM (
          SELECT
            CAST((minute - ?) / ? AS INTEGER) AS bucket_index,
            model_class,
            error_type,
            status_code,
            error_hint,
            count
          FROM target_model_error_observations
          WHERE minute >= ? AND minute <= ?
        )
        GROUP BY bucket_index, model_class, error_type, status_code, error_hint
        ORDER BY bucket_index ASC, model_class ASC, count DESC
      `)
            .bind(sinceMinute, bucketMinutes, sinceMinute, nowMinute)
            .all();
    }
    return db
        .prepare(`
      SELECT bucket_index, model_class, error_type, status_code, error_hint, SUM(count) AS count
      FROM (
        SELECT
          CAST((minute - ?) / ? AS INTEGER) AS bucket_index,
          model_class,
          error_type,
          status_code,
          error_hint,
          count
        FROM target_model_error_observations
        WHERE target_host = ? AND minute >= ? AND minute <= ?
      )
      GROUP BY bucket_index, model_class, error_type, status_code, error_hint
      ORDER BY bucket_index ASC, model_class ASC, count DESC
    `)
        .bind(sinceMinute, bucketMinutes, targetHost, sinceMinute, nowMinute)
        .all();
}
async function purgeExpiredData(db, nowMs, options) {
    const retentionCutoff = nowMs - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const detailRetentionDays = parseBoundedRetention(options.errorDetailRetentionDays, 31, 1, MAX_RETENTION_DAYS);
    const detailCutoffMinute = Math.floor((nowMs - detailRetentionDays * 24 * 60 * 60 * 1000) / 60000);
    const aggregateCutoffMinute = Math.floor(retentionCutoff / 60000);
    await db.batch([
        db.prepare("DELETE FROM daily_report_counts WHERE updated_at < ?").bind(retentionCutoff),
        db.prepare("DELETE FROM target_model_error_observations WHERE minute < ?").bind(detailCutoffMinute),
        db.prepare("DELETE FROM target_minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute),
        db.prepare("DELETE FROM target_model_minute_aggregates WHERE minute < ?").bind(aggregateCutoffMinute)
    ]);
}
function parseBoundedRetention(value, fallback, min, max) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
async function reserveDailyReportSlot(db, anonymousId, nowMs) {
    const day = getShanghaiDayKey(nowMs);
    const result = await db.prepare(`
    INSERT INTO daily_report_counts (day, anonymous_id, count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(day, anonymous_id) DO UPDATE SET
      count = count + 1,
      updated_at = ?
    RETURNING count
  `).bind(day, anonymousId, nowMs, nowMs).all();
    const count = Number(result.results?.[0]?.count ?? 1);
    if (count > SERVER_DAILY_REPORT_HARD_LIMIT)
        return "drop";
    if (count > SERVER_DAILY_REPORT_SOFT_LIMIT)
        return "sample";
    return "accept";
}
function getShanghaiDayKey(nowMs) {
    return new Date(nowMs + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}
