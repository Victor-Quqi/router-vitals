# 上报与隐私

插件按 Claude Code 用户轮次工作：`UserPromptSubmit` 记一轮开始，`Stop` / `StopFailure` 后判断这轮结果。状态页也按轮次计数，一轮对应一条观察事件。

> 插件只用 `ANTHROPIC_BASE_URL` 判断你连的是不是 Any Router，从不修改、转发或代理 Claude Code 发往上游的请求。从 Any Router 的视角，装不装这个插件收到的请求完全一样，没有任何额外特征。插件自己的出站请求（上报、拉配置、拉状态）只发给状态站 Worker，不经过 Any Router。

## 什么时候才会上报

要同时满足这些条件：

- 这轮开始和结束时，`ANTHROPIC_BASE_URL` 的 host 都命中 Any Router 入口。
- 本机没设 `ANYROUTER_STATUS_DISABLED=1`。
- 远程配置处于开启状态。
- 这轮通过成功/失败采样。
- 今日上报量没到上限。

Any Router 入口：

- 主站直连
- 大陆优化

下面这些情况直接跳过：`ANTHROPIC_BASE_URL` 为空、格式无效、host 不在内置端点里；开始时命中、结束时已经切到别的 host；这轮缺 `UserPromptSubmit` 起点；采样没命中；上报 API 临时不可用。

## 上报哪些内容

会提交：成功/失败、错误分类、HTTP 状态码、脱敏截断后的错误摘要、模型类别、响应开始区间、分钟级时间桶、插件版本、匿名 ID、采样率、目标命中标记、端点类别。

不会提交：真实 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志、精确时间戳。

为避免 Claude Code 会话内切换模型后串到旧模型，插件会在本机读取 hook 输入里的 transcript 文件，只提取模型归类和响应开始所需的元数据：本轮 assistant 记录中的模型字段、prompt 前 `/model` 本地命令成功输出里的模型名、首条 assistant 记录时间；不会提交 transcript 路径或内容。状态页的首次响应 P50 只统计最终成功的轮次。这个区间不是底层 API TTFT，会包含 Claude Code 自动重试等用户实际等待。

## 关掉上报

设环境变量 `ANYROUTER_STATUS_DISABLED=1`，本机就不再上报。

## 自托管 / 调试的覆盖项

自己部署或调试时可能需要：

- `ANYROUTER_STATUS_API_BASE_URL`：上报 API base URL。
- `ANYROUTER_STATUS_CONFIG_URL`：远程配置 JSON URL。
- `ANYROUTER_STATUS_STATE_DIR`：本地状态根目录覆盖。插件环境默认使用 Claude Code 插件数据目录。
- `ANYROUTER_STATUS_DEBUG_HOOK=1`：写本地 hook 诊断日志 `debug-hook.jsonl`，用于排查 session 事件、hook 输入摘要、pending/session 状态、上报决策、错误和 transcript 证据。

诊断某个 Claude Code session：

```bash
pnpm diagnose:session <session-id>
```

没有提前开启 `ANYROUTER_STATUS_DEBUG_HOOK=1` 的历史 session 只能读取 transcript 证据，无法还原当时的 hook stdin。诊断日志是本地 opt-in 文件，主要记录字段名、本地 transcript 路径、错误摘要、模型候选字段、状态转移和上报结果，不记录完整 prompt/response。

## 本地验证

看最近一次提交的 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

statusLine 只是展示层，hooks 照常独立运行。这里不做定时轮询；`近 60m 状态` 本地缓存 60 秒。有新版时 statusLine 优先显示更新提示；没配 statusLine 时，hooks 会低频发 Claude Code 系统消息。

Claude Code 当前只接受一个 `statusLine` 命令。`setup-statusline.mjs` 检测到已有非本插件 statusLine 时，交互终端会询问是否直接替换；非交互环境默认不覆盖。若要同时显示多个状态源，请自行编写 wrapper，或使用第三方 statusLine 聚合工具。
