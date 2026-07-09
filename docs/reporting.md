# 上报与隐私

插件按用户轮次工作，Claude Code 和 Codex 各有一条独立路径：一轮开始时记下起点，这轮结束后判断结果。Codex 侧失败轮会在结束后自动补记，本地结算异常中断时由后续交互恢复。状态页也按轮次计数，一轮对应一条观察事件。

> 插件只做本地判断，从不修改、转发或代理你发往上游的请求。Claude Code 侧用 `ANTHROPIC_BASE_URL` 判断你连的是不是 Any Router；Codex 侧读本会话元信息里的 provider 名，再在本机 Codex 配置里解析该 provider 的 `base_url`（只提取这两项，不读取 `env_key` 等任何密钥字段）。从 Any Router 的视角，装不装这个插件收到的请求完全一样，没有任何额外特征。插件自己的出站请求（上报、拉配置、拉状态）只发给状态站 Worker，不经过 Any Router。

## 什么时候才会上报

要同时满足这些条件：

- 这轮开始和结束时，客户端实际使用的 base URL host 都命中 Any Router 入口。
- 本机没设 `ROUTER_VITALS_DISABLED=1`。
- 远程配置处于开启状态。
- 这轮通过成功/失败采样。
- 今日上报量没到上限。

服务端还有滥用防护：除按匿名 ID 做每日限额外，也按来源 IP 做每日和每分钟限额。IP 只以加盐哈希形式短期存储用于计数，不保存原始 IP；哈希包含上海日日期，每天轮换，不能跨天关联。

Any Router 入口：

- 主站直连
- 大陆优化

下面这些情况直接跳过：base URL 为空、格式无效、host 不在内置端点里；开始时命中、结束时已经切到别的 host；这轮缺起点；采样没命中；Codex 侧用户主动中断的轮、找不到轮次证据的轮，以及无法可靠判定 provider 的场景（判定不了就不上报）。上报 API 临时不可用时，本轮不会计入贡献，插件会在本地状态里记录最近一次上报失败原因。

## 上报哪些内容

会提交：成功/失败、错误分类、HTTP 状态码、脱敏截断后的错误摘要、客户端类别（claude-code / codex）、模型类别、响应开始区间、分钟级时间桶、插件版本、匿名 ID、采样率、目标命中标记、端点类别。

不会提交：真实 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志、精确时间戳。

为避免 Claude Code 会话内切换模型后串到旧模型，插件会在本机读取 hook 输入里的 transcript 文件，只提取模型归类和响应开始所需的元数据：本轮 assistant 记录中的模型字段、prompt 前 `/model` 本地命令成功输出里的模型名、首条 assistant 记录时间；后台任务完成通知缺少这些证据时，会在同一 Claude 项目目录的近期 transcript 中只查找 `/model` 成功输出，用来归到通知触发时的当前模型。不会提交 transcript 路径或内容。Codex 侧同样只从本会话记录提取元数据（成败、报错摘要、模型名、响应耗时）。状态页的首次响应 P50 只统计最终成功的轮次。这个区间不是底层 API TTFT；Claude Code 侧包含自动重试等用户实际等待，Codex 侧用客户端自测的首 token 耗时，两者口径不同。

Codex 还要求非托管 hooks 审查信任后才运行：装完插件启动 Codex 会话时，按 hook 变化提示批准本插件 hooks；也可在会话里执行 `/hooks` 手动管理信任。轮次判定与结算的实现细节见 [codex-monitoring.md](codex-monitoring.md)。

## 关掉上报

设环境变量 `ROUTER_VITALS_DISABLED=1`，本机（两个客户端）就不再上报。

## 自托管 / 调试的覆盖项

自己部署或调试时可能需要：

- `ROUTER_VITALS_API_BASE_URL`：上报 API base URL。
- `ROUTER_VITALS_CONFIG_URL`：远程配置 JSON URL。
- `ROUTER_VITALS_STATE_DIR`：本地状态根目录覆盖；未设置时使用客户端提供的插件数据目录或系统状态目录。
- `ROUTER_VITALS_DEBUG_HOOK=1`：写本地 hook 诊断日志 `debug-hook.jsonl`，用于排查 session 事件、hook 输入摘要、pending/session 状态、上报决策、错误和 transcript 证据。

诊断某个 Claude Code session：

```bash
pnpm diagnose:session <session-id>
```

没有提前开启 `ROUTER_VITALS_DEBUG_HOOK=1` 的历史 session 只能读取 transcript 证据，无法还原当时的 hook stdin。诊断日志是本地 opt-in 文件，主要记录字段名、本地 transcript 路径、错误摘要、模型候选字段、状态转移和上报结果，不记录完整 prompt/response。

## 本地验证

看最近一次提交的 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

statusLine 只是展示层，hooks 照常独立运行。这里不做定时轮询；`近 60m 状态` 本地缓存 60 秒。有新版时 Claude Code 优先通过 statusLine 显示更新提示，未配置 statusLine 时由 hook 低频发系统消息；Codex 通过 Stop hook 的 systemMessage 提醒。最近一次本机上报失败时，statusLine 会显示短提示，详细原因用诊断脚本查看。

`setup-statusline.mjs` 会在 Claude home 写入稳定入口 `router-vitals-statusline.mjs`，并把 Claude Code `settings.json` 的 `statusLine` 指到这个入口。插件更新后，稳定入口会优先调用最新安装版本。

手动更新：

```bash
claude plugin update anyrouter-status-monitor@router-vitals
```

Codex：

```bash
codex plugin marketplace upgrade router-vitals
codex plugin add anyrouter-status-monitor@router-vitals
```

如果当前 Claude Code 会话正在运行，更新后在会话里执行 `/reload-plugins`。Codex 更新后新会话会在 hook sha 变化时提示信任，按提示批准即可；也可用 `/hooks` 手动管理。

Claude Code 当前只接受一个 `statusLine` 命令。`setup-statusline.mjs` 检测到已有非本插件 statusLine 时，交互终端会询问是否直接替换；非交互环境默认不覆盖。若要同时显示多个状态源，请自行编写 wrapper，或使用第三方 statusLine 聚合工具。
