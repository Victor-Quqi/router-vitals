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

会提交：成功/失败、错误分类、HTTP 状态码、脱敏截断后的错误摘要、模型类别、耗时区间、分钟级时间桶、插件版本、匿名 ID、采样率、目标命中标记、端点类别。

不会提交：真实 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志、精确时间戳。

为避免 Claude Code 会话内切换模型后串到旧模型，插件会在本机读取 hook 输入里的 transcript 文件尾部，只提取最近 assistant 记录中的模型元数据用于归类；不会提交 transcript 路径或内容。

## 关掉上报

设环境变量 `ANYROUTER_STATUS_DISABLED=1`，本机就不再上报。

## 自托管 / 调试的覆盖项

自己部署或调试时可能需要：

- `ANYROUTER_STATUS_API_BASE_URL`：上报 API base URL。
- `ANYROUTER_STATUS_CONFIG_URL`：远程配置 JSON URL。
- `ANYROUTER_STATUS_STATE_DIR`：本地状态目录。默认用系统用户 state 目录，让 hooks 和手动配置的 statusLine 读同一份状态。

## 本地验证

看最近一次提交的 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

statusLine 只是展示层，hooks 照常独立运行。Claude Code 会在状态变化时重跑 statusLine，这里不做定时轮询，避免长任务期间一直请求状态 API。`今日贡献` 每次运行读本地 state，提交成功后下次刷新；`近 60m 状态` 来自 Worker API，本地缓存 60 秒。
