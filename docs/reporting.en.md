# Reporting & Privacy

The plugin works at user-turn granularity with an independent path per client: a turn is marked when it starts and judged when it ends. Failed Codex turns are back-filled by the session's next interaction. The status page also counts turns — one turn maps to one observation event.

> The plugin only makes local checks; it never modifies, forwards, or proxies the requests you send upstream. On Claude Code it uses `ANTHROPIC_BASE_URL` to tell whether you're connected to Any Router; on Codex it reads the provider name from this session's metadata and resolves that provider's `base_url` from your local Codex config (only those two items are extracted — secret fields such as `env_key` are never read). From Any Router's point of view, the requests it receives are identical whether or not this plugin is installed — no extra fingerprint. The plugin's own outbound requests (reporting, config, status) go only to the status Worker, never through Any Router.

## When an event is submitted

All of these must hold:

- The base URL host the client actually uses matches an Any Router target host at both turn start and turn end.
- `ANYROUTER_STATUS_DISABLED=1` is not set locally.
- Remote reporting config is enabled.
- The turn passes success/failure sampling.
- The local daily report cap has not been reached.

Any Router targets:

- Main endpoint
- Mainland-optimized endpoint

These cases are skipped: empty or invalid base URL, non-target hosts, target matched at turn start but changed before turn end, missing turn start, sampling miss; on Codex also user-interrupted turns, turns with no evidence, and sessions whose provider cannot be reliably determined (undeterminable means no report). If the report API is temporarily unavailable, the turn is not counted as a contribution and the plugin records the most recent local report failure reason.

## What is reported

Submitted: success/failure, error class, HTTP status code, sanitized and truncated error hint, client class (claude-code / codex), model class, assistant-start bucket, minute-level time bucket, plugin version, anonymous ID, sample rate, target match marker, and target host class.

Not submitted: actual URL, prompt, response, tokens, cookies, keys, account identifiers, `session_id`, file paths, full logs, and precise timestamps.

To avoid carrying a stale model after switching models inside a Claude Code session, the plugin reads the local transcript file from the hook input and extracts only the metadata needed for model classification and assistant-start timing: model fields from this turn's assistant records, the model name from successful local `/model` command output before the prompt, and the first assistant record timestamp. It never submits transcript paths or content. Codex likewise only extracts metadata from this session's records (outcome, error summary, model name, response timing). The status page's assistant-start P50 only counts turns that eventually succeed. This bucket is not low-level API TTFT; the Claude Code reading includes user-visible waiting such as automatic retries, while the Codex reading uses the client's own time-to-first-token measurement — the two definitions differ.

Codex also requires reviewing and trusting non-managed hooks before they run: after installing, run `/hooks` inside a Codex session and trust this plugin's hooks; re-trust after plugin updates. Implementation details of turn detection and settlement live in [codex-monitoring.md](codex-monitoring.md) (Chinese).

## Turning reporting off

Set `ANYROUTER_STATUS_DISABLED=1` and the machine stops reporting (both clients).

## Self-hosting / debugging overrides

Not needed normally — only when self-hosting or debugging:

- `ANYROUTER_STATUS_API_BASE_URL`: report API base URL.
- `ANYROUTER_STATUS_CONFIG_URL`: remote config JSON URL.
- `ANYROUTER_STATUS_STATE_DIR`: local state root override. Plugin runs use Claude Code's plugin data directory by default.
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

statusLine is display-only; hooks keep running independently. There is no interval polling; `近 60m 状态` is cached locally for 60 seconds. Update hints prefer statusLine, and fall back to low-frequency Claude Code system messages when statusLine is not configured. When the most recent local report attempt failed, statusLine shows a short hint; use the diagnosis script for details.

`setup-statusline.mjs` writes a stable launcher, `router-vitals-statusline.mjs`, into Claude home and points Claude Code `settings.json` at it. After plugin updates, the launcher prefers the latest installed version.

Manual update:

```bash
claude plugin update anyrouter-status-monitor@router-vitals
```

If a Claude Code session is already running, run `/reload-plugins` inside that session after updating.

Claude Code currently accepts one `statusLine` command. When `setup-statusline.mjs` detects an unrelated existing statusLine, an interactive terminal asks before replacing it; non-interactive runs keep the existing command. To show multiple status sources, use your own wrapper or a third-party statusLine aggregator.
