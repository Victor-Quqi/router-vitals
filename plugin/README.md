# Any Router Status Monitor Plugin

Claude Code 插件包。上报规则、payload schema 和脱敏边界以仓库根目录 [README.md](../README.md) 和 `scripts/lib/policy-core.mjs` 为准。

状态页：https://router-vitals.pages.dev/

## 本地命令

预览最近一次提交的 payload：

```bash
node scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node scripts/statusline.mjs
```

Claude Code 的主 statusLine 需要手动配置。先查看插件安装目录：

```bash
claude plugin list --json
```

找到 `anyrouter-status-monitor@router-vitals` 的 `installPath`，然后把 `command` 指到该目录下的 `scripts/statusline.mjs`：

```json
"statusLine": {
  "command": "node \"C:/Users/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

Linux/macOS 示例：

```json
"statusLine": {
  "command": "node \"/home/<you>/.claude/plugins/cache/router-vitals/anyrouter-status-monitor/0.1.10/scripts/statusline.mjs\"",
  "type": "command"
}
```

不能只下载单个 `statusline.mjs`。它依赖 `scripts/lib/` 下的同包文件，需要完整插件目录。如果从仓库克隆运行，也可以指向仓库里的 `plugin/scripts/statusline.mjs`。

statusLine 大致显示：`Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`。满额后会提示 `今日已满`。

hooks 和 statusLine 是两条独立路径；statusLine 报错时，Claude Code 会继续跑 hooks。这里不配置定时轮询，近 60m 状态在本地缓存 60 秒。
