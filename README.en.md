# Any Router Status Monitor

[中文](README.md)

A Claude Code plugin for monitoring the current Any Router status.

Repeated probes from one account tend to trip upstream risk controls, rate limits, or bans, and only reflect that one account anyway. This plugin does not probe actively; instead, after each turn it anonymously reports whether the turn succeeded or failed, then aggregates those reports into a community status signal.

Install it and you're done; it stays quiet in the background. The plugin never touches the requests you send upstream, so it leaves no extra fingerprint on Any Router. To see the status inside Claude Code, set up the status line once; you can also open the status page.

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

Once installed, the hooks start working. Don't want to contribute? Set `ANYROUTER_STATUS_DISABLED=1`.

### Show status in the status line (recommended)

To see live status in the Claude Code status line, run the setup command once.

First find where the plugin is installed:

```bash
claude plugin list --json
```

Take the `installPath` for `anyrouter-status-monitor@router-vitals`, then run:

```bash
node "<installPath>/scripts/setup-statusline.mjs"
```

On Linux/macOS use the matching absolute path.

If another statusLine is already configured, the setup command does not replace it by default. Add `--force` when you explicitly want to replace it.

Once configured, the status line looks roughly like: `Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`.

When a newer plugin version is available, the status line appends an update hint. You can update manually from the CLI:

```bash
claude plugin marketplace update router-vitals
claude plugin update anyrouter-status-monitor@router-vitals
```

If a Claude Code session is already running, run `/reload-plugins` inside that session after updating.

**Keep the plugin up to date.** Older versions may use outdated reporting rules, target endpoints, or status logic, which can skip your local contributions or make the status line less accurate.

## Learn more

- [What gets reported, and how privacy is handled](docs/reporting.en.md)
- Self-hosting: [Cloudflare setup](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md) (both in Chinese)
