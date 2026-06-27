# CI/CD

项目默认走 GitHub Actions + Cloudflare。

Cloudflare 从零配置见 [cloudflare-setup.md](cloudflare-setup.md)。

## CI

`.github/workflows/ci.yml` 会在 PR 和所有分支 push 时运行：

```bash
pnpm test
```

随后检查编译产物是否已提交：

```bash
git diff --exit-code -- plugin worker shared status-page scripts
```

## CD

`.github/workflows/deploy-cloudflare.yml` 会在 `main` push 且改到运行时代码、状态页、Worker、共享策略、依赖或 TypeScript 配置时运行，也能手动触发。运行时会：

1. 运行测试。
2. 编译 TypeScript。
3. 把 GitHub Variables 里的 D1 database id 注入 `worker/wrangler.toml`。
4. 把 API 域名注入 `status-page/config.js`。
5. 执行 D1 migrations。
6. 部署 Worker。
7. 部署 Cloudflare Pages。

部署所需的 GitHub Secrets、Variables 和首次部署顺序见 [cloudflare-setup.md](cloudflare-setup.md)。

Pages 项目名默认写死为 `router-vitals`。如果 Cloudflare Pages 项目使用其他名字，改 `.github/workflows/deploy-cloudflare.yml` 里的 `pages deploy` 命令。
