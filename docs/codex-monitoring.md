# Codex 侧监测的技术设计

面向维护者的实现参考。用户可见的上报规则和隐私边界见 [reporting.md](reporting.md)，本文只记录 Codex 路径的机制、依据和已知限制。

## 扩展点

插件通过 Codex 的插件系统分发（`plugin/.codex-plugin/plugin.json`），hooks 由 manifest 指向 `plugin/hooks/codex-hooks.json`，注册 `SessionStart` / `UserPromptSubmit` / `Stop` 三个事件，命令统一走 `node "${PLUGIN_ROOT}/scripts/hook.mjs" <Event> --client=codex`。

在 codex-cli 0.142.5（Windows）上实测确认：

- hooks 在交互 TUI 和 `codex exec` 下都会触发；hook 进程继承 Codex 进程环境。
- hook 命令字符串不做任何 env 展开（`${VAR}`、`$VAR`、`%VAR%` 均不生效，`commandWindows` 同样），但插件捆绑 hooks 中的 `${PLUGIN_ROOT}` 由 Codex 自行替换，Windows 下同样生效。
- 插件 hook 进程带 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`（兼容 Claude 插件），`state.mts` 的状态目录选择逻辑因此对两个客户端通用，且状态天然按客户端隔离。
- hook stdin 公共字段：`session_id`、`transcript_path`（指向 rollout）、`cwd`、`hook_event_name`、`model`、`permission_mode`；`UserPromptSubmit` / `Stop` 额外带 `turn_id`。
- 市场布局是仓库根 `.agents/plugins/marketplace.json`，`codex plugin marketplace add <repo>` + `codex plugin add anyrouter-status-monitor@router-vitals` 即完成安装；插件按版本缓存在 `$CODEX_HOME/plugins/cache/` 下运行。

## 轮次模型与结算

Codex 没有 `StopFailure` 和 `SessionEnd`。实测 0.142.5：成功轮的 `Stop` 正常触发，轮次因上游错误终止时 **`Stop` 不触发**（exec 与 TUI 一致）。因此 Codex 路径采用"结算"模型（`codex-flow.mts`）：

- `UserPromptSubmit` 记 pending（唯一结算 ID、`turn_id`、起始时间、transcript 偏移、目标命中、模型类别），并启动独立 watcher。watcher 增量读取 rollout 后续新增字节，发现本轮 `task_complete` / `turn_aborted` 后立即结算；完整轮次证据只在结算时扫描一次。
- watcher 启动时与 hook 做 ready 握手，静态依赖全部载入后 hook 才退出。Codex 随后替换插件缓存目录时，已启动 watcher 仍可完成当前轮。
- `Stop` 结算正常结束的当前轮。watcher、`Stop` 和其他恢复事件共享跨进程状态锁，并以 pending 的唯一结算 ID 确认所有权，同一轮只会被一个结算方消费。
- `SessionStart`（含 resume）也先结算遗留 pending。实测 resume 保持同一 `session_id` 并续写同一 rollout 文件，`codex exec resume` 也能触发结算。注意 0.142.5 TUI 的 `SessionStart` hook 并非在会话打开时触发，而是延迟到首条用户消息时与其 `UserPromptSubmit` 背靠背触发（新会话与 resume 一致）——因此 resume 对遗留 pending 的补结算发生在用户 resume 后首次发言时，而非 resume 瞬间。
- 任意后续 Codex hook 事件仍会恢复同会话 pending，并补结算其他会话已结束的 pending，每次事件至多消费 2 条。跨会话证据和 `session_meta.model_provider` 始终读取原会话 rollout。
- watcher 连续 30 分钟看不到 rollout 增长或运行达到 24 小时会退出，pending 保留给后续 hook 恢复。结束标记超过 15 分钟的遗留 pending 会清除并记为 `pending_expired`，不上报。

本地 state schema 当前为 v2，pending 明确区分客户端并要求唯一结算 ID。旧 schema 会整体丢弃；项目尚未运营，不做迁移。

两个已实测确认的写盘时序，解析层都已适配：

- `task_started` / `turn_context` 在 `UserPromptSubmit` hook 运行**之前**落盘，prompt 时记录的偏移会越过轮次起始标记——扫描起点从偏移回退 64KB（`TURN_START_REWIND_BYTES`），配合 turn_id 门控多扫无害。
- exec 模式下 `task_complete` 在 `Stop` hook 返回**之后**才落盘，Stop 结算拿不到 `time_to_first_token_ms`，响应开始退化为 rollout 时间戳差（task_started → 首个输出 item，同一写入方时钟）；TUI 会话（`session_meta.originator` 不含 exec）会做一次 250ms 重扫，机会主义补拿真 TTFT。

## rollout 证据

rollout（`$CODEX_HOME/sessions/**/rollout-*.jsonl`）每行 `{timestamp, type, payload}`，官方声明非稳定接口，解析全部防御式退化：

- `session_meta`（首行）：`model_provider` 是本会话实际生效的 provider id——目标判定的权威来源，对 `profile` 切换免疫；`-c model_providers.*.base_url=` 级别的命令行覆盖不可见，此时保守跳过。
- `turn_context`：带 `turn_id` 和 `model`。
- `event_msg:task_started` / `task_complete`：轮次边界；`task_complete` 带 `duration_ms` 和 `time_to_first_token_ms`（客户端自测 TTFT，响应开始区间优先用它）。
- `event_msg:turn_aborted`（`reason: "interrupted"`）：用户中断，跳过不上报。
- `event_msg:error`：`message` 内含上游报错原文（HTTP 状态码、request id、URL），走既有 `classifyError` / `extractErrorStatusCode` / `sanitizeErrorHint` 管线。
- 成败判据是**轮内有无模型输出证据**（`agent_message` 事件，或 `reasoning` / `function_call` / `custom_tool_call` / `web_search_call` / assistant `message` 类 response_item），不依赖 error 事件——实测 0.142.5 下 exec 与 TUI 的错误轮（401、网络拒绝、上游 high demand）rollout 均只写一条无输出的 `task_complete`，不写 error 事件（0.117 / 0.128 时代会写）。error 事件缺失时错误分类退化为 `unknown`，未来版本若恢复该事件则分类自动变富。

## 目标判定

`codex-target.mts`：provider id 只取 rollout `session_meta.model_provider`。缺失时跳过不上报；不会从 `profile`、顶层 `model_provider`、`OPENAI_BASE_URL` 或内置默认值推断。`base_url` 从 `$CODEX_HOME/config.toml` 的 `[model_providers.<id>]` 解析——手写 TOML 子集解析器，只提取 section 头和 provider `base_url` 字符串键，密钥字段（`env_key` 等）不进入解析结果。host 命中逻辑与 Claude 侧共用 `matchTargetBaseUrl`。

## 已知限制

- 失败轮通常在 rollout 写入结束标记后的一个 watcher 轮询周期内上报。watcher 未启动或提前退出时，本机之后任意 Codex hook 事件会恢复结算；结束超过 15 分钟的遗留 pending 会清除不上报。如果原 rollout 被删除或归档导致证据不可读，该 pending 无法结算，7 天后由本地 state GC 丢弃。
- 已在真实 AnyRouter 上游实测：成功轮 Stop 结算与上报 payload 构造正确；故障轮（high demand）无 error 事件，失败判定走"无输出证据"，错误分类退化为 `unknown`。TUI 错误轮已实测（0.142.5）：同样无 error 事件、无 Stop。watcher 路径已用带 429 error 证据的合成 rollout 做集成验证；真实上游不写 error 时仍只能归为 `unknown`。
- Codex 的插件市场自动刷新存在运行中缓存路径失效问题，跟踪见 [openai/codex#31383](https://github.com/openai/codex/issues/31383)。ready 握手保护已经载入的 watcher；自动刷新导致当前进程不再触发 hooks 时，未开始的新轮次无法记录，也不会上报。
- Codex 侧更新提醒走 `Stop` hook 的 `systemMessage`（与 Claude 侧同频率）。更新是固定两步（已用 git 市场实测）：`codex plugin marketplace upgrade router-vitals` 刷新市场快照，`codex plugin add anyrouter-status-monitor@router-vitals` 从快照装进插件实际运行的版本化缓存——只 `add` 会装回旧快照版本，只 `upgrade` 不动缓存（此时 `codex plugin list` 显示的是快照版本，有误导性）。提醒文案不用 `&&`（PowerShell 5.1 不支持）。statusLine 无对应扩展点。
- Codex 信任模型按 hook 定义 hash 记录，插件每次更新 hooks 定义后，新会话会提示 hook 有变化，用户可批准当前插件或全部信任；`/hooks` 作为手动管理入口。
