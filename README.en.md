# Any Router Status Monitor

[中文](README.md)

A Claude Code plugin for checking whether Any Router is currently working well.

It doesn't probe actively — repeatedly probing from one account tends to trip upstream risk controls, rate limits, or bans, and only reflects that one account anyway. Instead, everyone uses Claude Code normally, and after each turn the plugin anonymously reports whether the turn succeeded or failed. Those results add up to a community status signal.

Install it and you're done; it stays quiet in the background. The plugin only reads an env var to tell whether you're on Any Router — it never touches the requests you send upstream, so it leaves no extra fingerprint on Any Router. To see the status, set up the status line or open the status page.

Status page: https://router-vitals.pages.dev/

Thanks to the [LINUX DO](https://linux.do/) community for the support.

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

Once installed, the hooks start working. Don't want to take part? Set `ANYROUTER_STATUS_DISABLED=1` to turn reporting off at any time.

### Show status in the status line (optional)

To see live status in the Claude Code status line, configure statusLine manually.

First find where the plugin is installed:

```bash
claude plugin list --json
```

Take the `installPath` for `anyrouter-status-monitor@router-vitals` and point statusLine at `scripts/statusline.mjs` inside it:

```json
"statusLine": {
  "command": "node \"C:/Users/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

On Linux/macOS use the matching absolute path. A few notes:

- You need the full plugin directory, not just `statusline.mjs` — it imports sibling files under `lib/`.
- The version directory changes after plugin upgrades, so update the path in `command` accordingly.
- Running from a cloned repo? Point straight at `plugin/scripts/statusline.mjs`.

Once configured, the status line looks roughly like: `Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`. When the daily cap is reached it shows `今日已满`.

## Learn more

- [What gets reported, and how privacy is handled](docs/reporting.en.md)
- Self-hosting: [Cloudflare setup](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md) (both in Chinese)
