# Any Router Status Monitor

[English](README.en.md)

Claude Code 插件，把 Any Router 公益站的实际使用结果汇总成社区状态。安装后，每个 Claude Code 用户轮次结束时，插件会根据 hook 结果提交一条精简事件。

这个项目不做单账号主动轮询。单账号持续探测很容易触发上游风控、限流甚至封禁，也会把状态判断变成某个账号的个体情况。这里改用社区用户的真实 Claude Code 轮次做匿名汇总，只看实际使用结果。

感谢 [LINUX DO](https://linux.do/) 社区的支持。

状态页：https://router-vitals.pages.dev/

## 安装

在 Claude Code 里运行：

```text
/plugin marketplace add Victor-Quqi/router-vitals
/plugin install anyrouter-status-monitor@router-vitals
```

命令行等价形式：

```bash
claude plugin marketplace add Victor-Quqi/router-vitals
claude plugin install anyrouter-status-monitor@router-vitals
```

这两条命令会把 marketplace 和 enabled plugin 写进 Claude Code 配置。hooks 会随插件启用；statusLine 是 Claude Code 的全局配置，需要自己加。

先查看插件安装目录：

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

statusLine 不能只下载单个 `statusline.mjs`。它会 import 同目录下的 `lib/config.mjs`、`lib/state.mjs`、`lib/policy.mjs` 等文件，需要完整插件目录。如果是从本仓库克隆运行，也可以指向仓库里的 `plugin/scripts/statusline.mjs`，例如：

```json
"statusLine": {
  "command": "node \"D:/vc-proj/router-vitals/plugin/scripts/statusline.mjs\"",
  "type": "command"
}
```

插件更新后，Claude Code cache 里的版本目录可能变化；如果 statusLine 使用的是 cache 路径，更新插件后同步改一下 `command`。

statusLine 大致显示：`Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`。满额后会提示 `今日已满`。

## 上报规则

插件围绕 Claude Code 用户轮次工作：`UserPromptSubmit` 记录本轮开始，`Stop` / `StopFailure` 后判断本轮结果。

写入社区状态数据需要同时满足这些条件：

- 本轮开始和结束时，当前进程的 `ANTHROPIC_BASE_URL` host 都命中 Any Router 入口。
- 本机未设置 `ANYROUTER_STATUS_DISABLED=1`。
- 远程配置处于开启状态。
- 本轮通过成功/失败采样率。

Any Router 入口：

- 主站直连
- 大陆优化

这些情况直接跳过：`ANTHROPIC_BASE_URL` 为空、格式无效、host 不属于内置端点；本轮开始时命中但结束时已经切到别的 host；本轮缺少 `UserPromptSubmit` 起点；采样未命中；上报 API 暂时不可用。

状态页按 Claude Code 用户轮次计数，一轮对应一条观察事件。插件读取 `ANTHROPIC_BASE_URL` 判断入口；请求本身仍由 Claude Code 走原来的上游。

提交字段：成功/失败、错误分类、HTTP 状态码、脱敏截断后的错误摘要、模型类别、耗时区间、分钟级时间桶、插件版本、匿名 ID、采样率、目标命中标记和端点类别。

这些内容不会提交：实际 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志、精确时间戳。

设置环境变量 `ANYROUTER_STATUS_DISABLED=1` 会在本机停用上报。

自托管或调试时才需要覆盖：

- `ANYROUTER_STATUS_API_BASE_URL`：上报 API base URL。
- `ANYROUTER_STATUS_CONFIG_URL`：远程配置 JSON URL。
- `ANYROUTER_STATUS_STATE_DIR`：本地状态目录。默认使用系统用户 state 目录，让 hooks 和手动配置的 statusLine 读同一份状态。

## 本地检查

预览最近一次提交的 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

statusLine 只是展示层；hooks 仍按上面的规则运行。Claude Code 会在状态变化时重跑 statusLine；这里不配置定时轮询，避免长程任务期间持续请求状态 API。`今日贡献` 每次运行都读取本地 state，成功提交后在下一次 statusLine 运行时更新；`近 60m 状态` 来自 Worker API，本地缓存 60 秒。

## 维护入口

- `src/plugin/scripts/hook.mts`：Claude Code hook 上报入口。
- `src/plugin/scripts/statusline.mts`：statusLine 输出。
- `src/plugin/scripts/lib/policy-core.mts`：目标 host、schema、分类、脱敏、插件版本。
- `src/worker/src/index.mts`：Worker API 和 D1 写入查询。
- `src/worker/src/status.mts`：状态聚合和阈值。
- `src/status-page/app.ts`：状态页渲染和交互。

行为改动后运行：

```bash
pnpm test
```

改到运行时代码时再运行：

```bash
pnpm run typecheck
```
