# Any Router Status Monitor

[中文](README.md)

A Claude Code plugin for monitoring the current Any Router status.

Repeated probes from one account tend to trip upstream risk controls, rate limits, or bans, and only reflect that one account. This plugin anonymously reports whether each Claude Code turn succeeded or failed, then aggregates those reports into a community status signal.

Install it and you're done. The plugin never touches the requests you send upstream, so it leaves no extra fingerprint on Any Router.

Status page: https://router-vitals.pages.dev/

![Status page preview](docs/assets/status-page-preview.png)

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

First find where the plugin is installed:

```bash
claude plugin list --json
```

Take the `installPath` for `anyrouter-status-monitor@router-vitals`, then run:

```bash
node "<installPath>/scripts/setup-statusline.mjs"
```

## Learn more

- [What gets reported, and how privacy is handled](docs/reporting.en.md)
- Self-hosting: [Cloudflare setup](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md) (both in Chinese)
