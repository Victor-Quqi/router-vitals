# Any Router Status Monitor

[English](README.en.md)

一个 Claude Code 插件，用来监测 Any Router 当前状态。

单账号反复探测容易触发上游风控、限流甚至封号，而且只代表那一个账号。这里本插件不主动探测，而是每轮结束后匿名上报这轮成功还是失败，汇总成社区状态。

装上即可做出贡献，平时完全无感——插件不碰你发往上游的请求，对 Any Router 不留任何额外特征。想在 Claude Code 里看状态，按下面配置一次状态栏；也可以直接打开状态页。

状态页：https://router-vitals.pages.dev/

感谢 [LINUX DO](https://linux.do/) 社区的支持。

## 安装

在 Claude Code 里运行：

```text
/plugin marketplace add Victor-Quqi/router-vitals
/plugin install anyrouter-status-monitor@router-vitals
```

命令行等价：

```bash
claude plugin marketplace add Victor-Quqi/router-vitals
claude plugin install anyrouter-status-monitor@router-vitals
```

装完插件 hooks 就开始工作了。不想参与贡献，设环境变量 `ANYROUTER_STATUS_DISABLED=1` 即可。

### 在状态栏显示状态（推荐）

想在 Claude Code 状态栏看到实时状态，运行一次配置命令即可。

先找到插件装在哪：

```bash
claude plugin list --json
```

把 `anyrouter-status-monitor@router-vitals` 的 `installPath` 拿出来，运行：

```bash
node "<installPath>/scripts/setup-statusline.mjs"
```

Linux/macOS 换成对应的绝对路径。

已有其他 statusLine 时，配置命令默认不替换；确认要替换时加 `--force`。

配好后状态栏大致长这样：`Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`。

有新版时会追加更新提示。命令行手动更新：

```bash
claude plugin marketplace update router-vitals
claude plugin update anyrouter-status-monitor@router-vitals
```

如果当前 Claude Code 会话正在运行，更新后在会话里执行 `/reload-plugins`。

**建议保持最新版本**。旧版本可能使用过期的上报规则、目标入口或状态判断逻辑，导致本机贡献被跳过，或状态栏显示不准。

想让插件自动更新，进入 `/plugins` -> `Marketplaces` -> `router-vitals`，确认 `Enable auto-update` 已开启。

如果你特意用 `DISABLE_AUTOUPDATER=1` 关闭 Claude Code 自身更新，但仍想让插件自动更新，在 Claude Code Settings 的 JSON 里找到 `env`，加上：

```json
"env": {
  "DISABLE_AUTOUPDATER": "1",
  "FORCE_AUTOUPDATE_PLUGINS": "1"
}
```

改完重启 Claude Code。`/plugins` -> `Marketplaces` -> `router-vitals` 里的 `Enable auto-update` 正常应为开启；不确定时看一下这个位置。`FORCE_AUTOUPDATE_PLUGINS` 是 Claude Code 当前实现里的插件自动更新覆盖开关。不要同时设置 `DISABLE_INSTALLATION_CHECKS=1`，它可能导致插件自动更新失败。

## 想了解更多

- [上报了什么、怎么保护隐私](docs/reporting.md)
- 自己部署一套：[Cloudflare 配置](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md)
