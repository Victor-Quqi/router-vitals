# Router Vitals

Any Router 公益站社区状态监测 MVP。它不代理请求，不主动探测，只在用户真实使用 Claude Code 后，由插件匿名上报白名单状态字段。

监测目标固定为：

- `https://anyrouter.top`
- `https://a-ocnfniawgw.cn-shanghai.fcapp.run`

插件只检查当前进程的 `ANTHROPIC_BASE_URL` host 是否命中这两个入口。上报时不包含实际 URL、prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志或精确时间戳。失败轮次可上报 HTTP 状态码和脱敏截断后的错误摘要，不上传原始错误文本。

## 结构

- `plugin/`：Claude Code plugin hooks、statusLine、匿名上报脚本。
- `worker/`：Cloudflare Worker API 和 D1 迁移。
- `status-page/`：静态状态页。
- `shared/`：后端和测试复用的策略导出。
- `tests/`：Node 内置测试。

## 本地验证

```bash
npm test
```

本地预览状态页：

```bash
npm run status:preview
```

然后访问 `http://127.0.0.1:8788`。

Cloudflare 从零配置见 [docs/cloudflare-setup.md](docs/cloudflare-setup.md)，CI/CD 见 [docs/ci-cd.md](docs/ci-cd.md)。

## 插件运行配置

插件默认读取：

- `ANTHROPIC_BASE_URL`：Claude Code 当前上游。
- `ANYROUTER_STATUS_API_BASE_URL`：覆盖上报 API，默认 `https://api.status.example.com`。
- `ANYROUTER_STATUS_CONFIG_URL`：覆盖远程配置，默认 `https://config.status.example.com/config.json`。
- `ANYROUTER_STATUS_DISABLED=1`：本机停用上报。
- `ANYROUTER_STATUS_STATE_DIR`：覆盖本地状态目录。Claude Code 插件环境下默认优先使用 `${CLAUDE_PLUGIN_DATA}`。

Claude Code hook 会在 `UserPromptSubmit` 记录本轮开始时间，在 `Stop` / `StopFailure` 后尝试匿名上报。只有本轮开始和结束时都命中 Any Router 入口才会上报。

## 安装到 Claude Code

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

这个仓库目前是私有仓库，安装机器需要有 GitHub 访问权限。

## Cloudflare 部署要点

1. 创建 D1 数据库。
2. 把 `worker/wrangler.toml` 里的 `database_id` 改成实际值。
3. 执行 `worker/migrations/0001_initial.sql`。
4. 部署 Worker，并把 `api.status.example.com` 指向它。
5. 部署 `status-page/` 到 Cloudflare Pages 或 GitHub Pages，设置 `window.ANYROUTER_STATUS_API_BASE` 指向 Worker API。

状态页展示的是社区观测结果，不是官方 SLA。
