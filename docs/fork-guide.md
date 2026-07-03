# Fork 指南

Fork 后要监测另一个站点，按这四步走。

## 1. 改站点配置

编辑根目录 `site.config.json`：

- `siteName`
- `pluginId`
- `marketplace`
- `endpoints`
- `defaultApiBaseUrl`
- `statusPageUrl`
- `cloudflare`

`endpoints` 是插件本地判断和状态页端点 tab 的共同来源。

## 2. 同步并构建

运行：

```bash
pnpm run sync:site && pnpm run build
```

这会同步插件 manifest、插件市场、Wrangler 配置、状态页标题和生成配置模块。

## 3. 创建 Cloudflare 资源

按 [cloudflare-setup.md](cloudflare-setup.md) 创建 Worker、D1、Pages，并设置 GitHub Secrets / Variables。

Cloudflare 的 Worker 名、D1 名和 Pages 项目名来自 `site.config.json`。

## 4. 手工改门面和预览种子

`README.md` / `README.en.md` 是手写门面，不参与同步，按你的站点重写。

`worker/preview/seed.sql` 是本部署的本地预览种子数据，里面的 host 不会被 `site-sync` 改写。需要预览新站点数据时手工替换。
