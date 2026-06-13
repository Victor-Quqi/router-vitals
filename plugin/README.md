# AnyRouter Status Monitor Plugin

Claude Code 插件。它通过 hooks 记录真实使用结果，并匿名上报到 Router Vitals API。

## 采集边界

插件只在 `ANTHROPIC_BASE_URL` 的 host 命中以下入口时上报：

- `anyrouter.top`
- `a-ocnfniawgw.cn-shanghai.fcapp.run`

上报 payload 不包含实际 URL。插件不会读取 transcript，也不会上传 prompt、response、token、cookie、key、账号、`session_id`、文件路径、完整日志或精确时间戳。

## 本地命令

预览最近一次实际上报的白名单 payload：

```bash
node plugin/scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node plugin/scripts/statusline.mjs
```

## statusLine

Claude Code 的主 statusLine 如需使用本插件脚本，可把命令设置为：

```bash
node /path/to/plugin/scripts/statusline.mjs
```

插件 hooks 不依赖 statusLine；statusLine 失败时不会影响 Claude Code 使用。
