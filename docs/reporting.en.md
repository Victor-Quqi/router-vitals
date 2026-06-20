# Reporting & Privacy

The plugin works at Claude Code user-turn granularity: `UserPromptSubmit` records the start of a turn, and `Stop` / `StopFailure` records the result. The status page also counts turns — one turn maps to one observation event.

> The plugin uses `ANTHROPIC_BASE_URL` only to tell whether you're connected to Any Router; it never modifies, forwards, or proxies the requests Claude Code sends upstream. From Any Router's point of view, the requests it receives are identical whether or not this plugin is installed — no extra fingerprint. The plugin's own outbound requests (reporting, config, status) go only to the status Worker, never through Any Router.

## When an event is submitted

All of these must hold:

- `ANTHROPIC_BASE_URL` matches an Any Router target host at both turn start and turn end.
- `ANYROUTER_STATUS_DISABLED=1` is not set locally.
- Remote reporting config is enabled.
- The turn passes success/failure sampling.
- The local daily report cap has not been reached.

Any Router targets:

- Main endpoint
- Mainland-optimized endpoint

These cases are skipped: empty or invalid `ANTHROPIC_BASE_URL`, non-target hosts, target matched at turn start but changed before turn end, missing `UserPromptSubmit`, sampling miss, or temporary report API failure.

## What is reported

Submitted: success/failure, error class, HTTP status code, sanitized and truncated error hint, model class, assistant-start bucket, minute-level time bucket, plugin version, anonymous ID, sample rate, target match marker, and target host class.

Not submitted: actual URL, prompt, response, tokens, cookies, keys, account identifiers, `session_id`, file paths, full logs, and precise timestamps.

To avoid carrying a stale model after switching models inside a Claude Code session, the plugin reads the local transcript file from the hook input and extracts only the metadata needed for model classification and assistant-start timing: model fields from this turn's assistant records, the model name from successful local `/model` command output before the prompt, and the first assistant record timestamp. It never submits transcript paths or content. The status page's assistant-start P50 only counts turns that eventually succeed. This bucket is not low-level API TTFT and includes user-visible waiting such as Claude Code automatic retries.

## Turning reporting off

Set `ANYROUTER_STATUS_DISABLED=1` and the machine stops reporting.

## Self-hosting / debugging overrides

Not needed normally — only when self-hosting or debugging:

- `ANYROUTER_STATUS_API_BASE_URL`: report API base URL.
- `ANYROUTER_STATUS_CONFIG_URL`: remote config JSON URL.
- `ANYROUTER_STATUS_STATE_DIR`: local state directory. By default the plugin uses the user state directory so hooks and a manually configured statusLine read the same state.
- `ANYROUTER_STATUS_DEBUG_HOOK=1`: writes the local hook diagnostic log `debug-hook.jsonl` for session events, hook input summaries, pending/session state, report decisions, errors, and transcript evidence.

Diagnose one Claude Code session:

```bash
pnpm diagnose:session <session-id>
```

Historical sessions without `ANYROUTER_STATUS_DEBUG_HOOK=1` can only be diagnosed from transcript evidence; their hook stdin cannot be reconstructed. The diagnostic log is a local opt-in file and mainly records field names, the local transcript path, error summaries, model candidate fields, state transitions, and report results, not full prompts or responses.

## Local checks

Preview the last submitted payload:

```bash
node plugin/scripts/preview.mjs
```

Test statusLine output:

```bash
node plugin/scripts/statusline.mjs
```

statusLine is display-only; hooks keep running independently. Claude Code reruns statusLine when its status changes, and this plugin does no interval polling — that avoids hammering the status API during long tasks. `今日贡献` reads local state on each run and refreshes after a successful submit; when an update is available, statusLine prioritizes the update hint. `近 60m 状态` comes from the Worker API with a 60-second local cache.
