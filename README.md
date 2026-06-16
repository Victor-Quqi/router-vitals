# Any Router Status Monitor

Claude Code 插件，把 Any Router 公益站的实际使用结果汇总成社区状态。安装后，每个 Claude Code 用户轮次结束时，插件会根据 hook 结果提交一条精简事件。

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

这两条命令会把 marketplace 和 enabled plugin 写进 Claude Code 配置。如果要使用 statusLine，需要自己加。

statusLine 配置示例：

```json
"statusLine": {
  "command": "node \"/path/to/router-vitals/plugin/scripts/statusline.mjs\"",
  "type": "command"
}
```

把 `command` 里的路径改成实际的 `plugin/scripts/statusline.mjs` 路径。Windows 路径需要转义反斜杠，或直接使用 `/`。

## 上报规则

插件围绕 Claude Code 用户轮次工作：`UserPromptSubmit` 记录本轮开始，`Stop` / `StopFailure` 后判断本轮结果。

写入社区状态数据需要同时满足这些条件：

- 本轮开始和结束时，当前进程的 `ANTHROPIC_BASE_URL` host 都命中 Any Router 入口。
- 本机未设置 `ANYROUTER_STATUS_DISABLED=1`。
- 远程配置处于开启状态。
- 本轮通过成功/失败采样率。

Any Router 入口：

- `anyrouter.top`
- `a-ocnfniawgw.cn-shanghai.fcapp.run`

这些情况直接跳过：`ANTHROPIC_BASE_URL` 为空、格式无效、host 落在列表外；本轮开始时命中但结束时已经切到别的 host；本轮缺少 `UserPromptSubmit` 起点；采样未命中；上报 API 暂时不可用。

状态页按 Claude Code 用户轮次计数，一轮对应一条观察事件。插件读取 `ANTHROPIC_BASE_URL` 判断入口；请求本身仍由 Claude Code 走原来的上游。

提交字段：成功/失败、错误分类、HTTP 状态码、脱敏截断后的错误摘要、模型类别、耗时区间、分钟级时间桶、插件版本、匿名 ID、采样率和目标命中标记。

这些内容留在本机：实际 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志、精确时间戳。

设置环境变量 `ANYROUTER_STATUS_DISABLED=1` 会在本机停用上报。

自托管或调试时才需要覆盖：

- `ANYROUTER_STATUS_API_BASE_URL`：上报 API base URL。
- `ANYROUTER_STATUS_CONFIG_URL`：远程配置 JSON URL。
- `ANYROUTER_STATUS_STATE_DIR`：本地状态目录；Claude Code 插件环境下默认优先使用 `${CLAUDE_PLUGIN_DATA}`。

## 本地检查

预览最近一次提交的 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

statusLine 只是展示层；hooks 仍按上面的规则运行。

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
