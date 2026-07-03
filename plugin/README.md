# Any Router Status Monitor Plugin

Claude Code / Codex 插件包。上报规则、payload schema 和脱敏边界以 [docs/reporting.md](../docs/reporting.md) 和 `scripts/lib/policy-core.mjs` 为准；Codex 机制细节见 [docs/codex-monitoring.md](../docs/codex-monitoring.md)。

状态页：https://router-vitals.pages.dev/

## 本地命令（statusLine 仅 Claude Code）

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

已有其他 statusLine 时会询问是否直接替换；无提示替换加 `--force`。

hooks 和 statusLine 是两条独立路径；statusLine 报错不影响 hooks。
