# Any Router Status Monitor

[中文](README.md)

A Claude Code plugin that turns real Any Router community usage into a lightweight status signal. At the end of each Claude Code user turn, the hook submits a minimal event derived from the turn result.

This project does not run active polling from a single account. Continuous probing from one account is likely to trigger upstream risk controls, rate limits, or bans, and the result would mostly describe that one account. This plugin instead aggregates anonymous real Claude Code turns from the community.

Thanks to the [LINUX DO](https://linux.do/) community for the support.

Status page: https://router-vitals.pages.dev/

## Install

Run inside Claude Code:

```text
/plugin marketplace add Victor-Quqi/router-vitals
/plugin install anyrouter-status-monitor@router-vitals
```

CLI equivalent:

```bash
claude plugin marketplace add Victor-Quqi/router-vitals
claude plugin install anyrouter-status-monitor@router-vitals
```

These commands install and enable the plugin hooks. Claude Code statusLine is configured separately.

Find the installed plugin path:

```bash
claude plugin list --json
```

Use the `installPath` for `anyrouter-status-monitor@router-vitals`, then point `command` to `scripts/statusline.mjs` inside that directory:

```json
"statusLine": {
  "command": "node \"C:/Users/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

Linux/macOS example:

```json
"statusLine": {
  "command": "node \"/home/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

Do not download only `statusline.mjs`. It imports sibling files under `scripts/lib/`, so it needs the complete plugin directory. For a cloned repository, point to `plugin/scripts/statusline.mjs` in the repo instead:

```json
"statusLine": {
  "command": "node \"D:/vc-proj/router-vitals/plugin/scripts/statusline.mjs\"",
  "type": "command"
}
```

If the statusLine command uses a Claude Code cache path, update the path after plugin upgrades because the version directory may change.

statusLine roughly looks like: `Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`. When the local daily cap is reached, it shows `今日已满`.

## Reporting Rules

The plugin works at Claude Code user-turn granularity: `UserPromptSubmit` records the start of a turn, and `Stop` / `StopFailure` records the result.

An event is submitted only when all conditions match:

- `ANTHROPIC_BASE_URL` matches a built-in Any Router target host at both turn start and turn end.
- `ANYROUTER_STATUS_DISABLED=1` is not set locally.
- Remote reporting config is enabled.
- The turn passes success/failure sampling.
- The local daily report cap has not been reached.

Any Router targets:

- Main endpoint
- Mainland-optimized endpoint

These cases are skipped: empty or invalid `ANTHROPIC_BASE_URL`, non-target hosts, target matched at turn start but changed before turn end, missing `UserPromptSubmit`, sampling miss, or temporary report API failure.

The status page counts Claude Code user turns, not low-level API requests. The plugin reads `ANTHROPIC_BASE_URL` only to classify the target; Claude Code still sends requests to the original upstream.

Submitted fields: success/failure, error class, HTTP status code, sanitized and truncated error hint, model class, latency bucket, minute-level time bucket, plugin version, anonymous ID, sample rate, target match marker, and target host class.

These fields are not submitted: actual URL, prompt, response, tokens, cookies, keys, account identifiers, `session_id`, file paths, full logs, and precise timestamps.

Set `ANYROUTER_STATUS_DISABLED=1` to disable reporting locally.

Self-hosting or debugging overrides:

- `ANYROUTER_STATUS_API_BASE_URL`: report API base URL.
- `ANYROUTER_STATUS_CONFIG_URL`: remote config JSON URL.
- `ANYROUTER_STATUS_STATE_DIR`: local state directory. By default, the plugin uses the user state directory so hooks and manually configured statusLine read the same state.

## Local Checks

Preview the last submitted payload:

```bash
node plugin/scripts/preview.mjs
```

Test statusLine output:

```bash
node plugin/scripts/statusline.mjs
```

statusLine is display-only. Hooks continue to run independently. Claude Code reruns statusLine when its status changes; this plugin does not configure interval polling. `今日贡献` reads local state, and `近 60m 状态` comes from the Worker API with a 60-second local cache.

## Maintenance

- `src/plugin/scripts/hook.mts`: Claude Code hook reporting entry.
- `src/plugin/scripts/statusline.mts`: statusLine output.
- `src/plugin/scripts/lib/policy-core.mts`: target hosts, schema, classification, sanitization, plugin version.
- `src/worker/src/index.mts`: Worker API and D1 writes/queries.
- `src/worker/src/status.mts`: status aggregation and thresholds.
- `src/status-page/app.ts`: status page rendering and interactions.

After behavior changes:

```bash
pnpm test
```

After runtime code changes:

```bash
pnpm run typecheck
```
