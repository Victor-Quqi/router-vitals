# Any Router Status Monitor

[English](README.en.md)

一个 Claude Code 插件，用来看 Any Router 公益站当前状态。

它不主动探测——单账号反复探测容易触发上游风控、限流甚至封号，而且只代表那一个账号。这里换成：大家正常用 Claude Code，每轮结束后匿名上报这轮成功还是失败，汇总成社区状态。

装上即可做出贡献，平时完全无感——插件只读环境变量判断你连的是不是 Any Router，不碰你发往上游的请求，对 Any Router 不留额外特征。想看状态可以配一下状态栏，或直接打开状态页。

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

装完插件 hooks 就开始工作了。不想参与设环境变量 `ANYROUTER_STATUS_DISABLED=1` 即可。

### 在状态栏显示状态（可选）

想在 Claude Code 状态栏看到实时状态，要手动配一下 statusLine。

先找到插件装在哪：

```bash
claude plugin list --json
```

把 `anyrouter-status-monitor@router-vitals` 的 `installPath` 拿出来，让 statusLine 指向它下面的 `scripts/statusline.mjs`：

```json
"statusLine": {
  "command": "node \"C:/Users/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

Linux/macOS 换成对应的绝对路径即可。几个注意点：

- 要完整插件目录，不能只下一个 `statusline.mjs`——它还会 import 同目录的 `lib/`。
- 插件升级后版本号目录会变，记得同步改 `command` 里的路径。
- 从本仓库克隆运行的话，直接指向 `plugin/scripts/statusline.mjs` 亦可。

配好后状态栏大致长这样：`Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`；当天上报满额会显示 `今日已满`。

## 想了解更多

- [上报了什么、怎么保护隐私](docs/reporting.md)
- 自己部署一套：[Cloudflare 配置](docs/cloudflare-setup.md) · [CI/CD](docs/ci-cd.md)
