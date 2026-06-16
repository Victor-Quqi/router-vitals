# Any Router Status Monitor Plugin

Claude Code 插件包。上报规则、payload schema 和脱敏边界以仓库根目录 [README.md](../README.md) 和 `scripts/lib/policy-core.mjs` 为准。

## 本地命令

预览最近一次提交的 payload：

```bash
node scripts/preview.mjs
```

测试 statusLine 输出：

```bash
node scripts/statusline.mjs
```

Claude Code 的主 statusLine 需要手动配置。配置示例：

```json
"statusLine": {
  "command": "node \"/path/to/plugin/scripts/statusline.mjs\"",
  "type": "command"
}
```

把 `/path/to/plugin` 换成实际插件目录。Windows 路径需要转义反斜杠，或直接使用 `/`。

hooks 和 statusLine 是两条独立路径；statusLine 报错时，Claude Code 会继续跑 hooks。这里不配置定时轮询，近 60m 状态在本地缓存 60 秒。
