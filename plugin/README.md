# Any Router Status Monitor Plugin

Claude Code 插件包。上报规则、payload schema 和脱敏边界以 [docs/reporting.md](../docs/reporting.md) 和 `scripts/lib/policy-core.mjs` 为准。

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

配置 Claude Code 主 statusLine：

```bash
node scripts/setup-statusline.mjs
```

配置一次后，后续插件升级不用再改 statusLine 路径。

已有其他 statusLine 时，配置命令默认不替换；确认要替换时加 `--force`。

statusLine 大致显示：`Any Router 近 60m 状态: 可用 · 贡献开启 · 今日贡献 12 条`。满额后会提示 `今日已满`。

有新版时会追加 `插件有新版 x.y.z · 运行 /plugin`。命令行更新：

```bash
claude plugin marketplace update router-vitals
claude plugin update anyrouter-status-monitor@router-vitals
```

如果当前 Claude Code 会话正在运行，更新后在会话里执行 `/reload-plugins`。

**建议保持最新版本**。旧版本可能使用过期的上报规则、目标入口或状态判断逻辑，导致本机贡献被跳过，或状态栏显示不准。

如果你信任本仓库，可在 `/plugin` 里进入 `Marketplaces`，选择 `router-vitals`，开启 auto-update。

hooks 和 statusLine 是两条独立路径；statusLine 报错时，Claude Code 会继续跑 hooks。这里不配置定时轮询，近 60m 状态在本地缓存 60 秒。
