# Any Router Status Monitor

[中文](README.md)

A Claude Code plugin for checking whether Any Router is currently working well.

It doesn't probe actively — repeatedly probing from one account tends to trip upstream risk controls, rate limits, or bans, and only reflects that one account anyway. Instead, everyone uses Claude Code normally, and after each turn the plugin anonymously reports whether the turn succeeded or failed. Those results add up to a community status signal.

Install it and you're done; it stays quiet in the background. The plugin only reads an env var to tell whether you're on Any Router — it never touches the requests you send upstream, so it leaves no extra fingerprint on Any Router. To see the status inside Claude Code, set up the status line once; you can also open the status page.

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

On Linux/macOS use the matching absolute path. After this one-time setup, plugin upgrades do not require editing the statusLine path again.

If another statusLine is already configured, the setup command does not replace it by default. Add `--force` when you explicitly want to replace it.

Once configured, the status line looks roughly like: `Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`. When the daily cap is reached it shows `今日已满`.

When a newer plugin version is available, it appends `插件有新版 x.y.z · 运行 /plugin`. You can also update manually from the CLI:

```bash
claude plugin marketplace update router-vitals
claude plugin update anyrouter-status-monitor@router-vitals
```

If a Claude Code session is already running, run `/reload-plugins` inside that session after updating.

**Keep the plugin up to date.** Older versions may use outdated reporting rules, target endpoints, or status logic, which can skip your local contributions or make the status line less accurate.

If you do not want to update manually and trust this repository, you can also open `/plugin`, go to `Marketplaces`, choose `router-vitals`, and enable auto-update.

## Learn more

- [What gets reported, and how privacy is handled](docs/reporting.en.md)
- Self-hosting: [Cloudflare setup](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md) (both in Chinese)
