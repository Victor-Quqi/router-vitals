# CI/CD

项目默认走 GitHub Actions + Cloudflare。

Cloudflare 从零配置见 [cloudflare-setup.md](cloudflare-setup.md)。

## CI

`.github/workflows/ci.yml` 会在 PR 和所有分支 push 时运行：

```bash
npm test
```

## CD

`.github/workflows/deploy-cloudflare.yml` 会在 `main` push 或手动触发时：

1. 运行测试。
2. 把 GitHub Variables 里的 D1 database id 注入 `worker/wrangler.toml`。
3. 把 API 域名注入 `status-page/config.js`。
4. 执行 D1 migrations。
5. 部署 Worker。
6. 部署 Cloudflare Pages。

## GitHub Secrets

仓库需要配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API token 至少需要能编辑 Workers、D1 和 Pages。

## GitHub Variables

仓库需要配置：

- `CLOUDFLARE_D1_DATABASE_ID`
- `STATUS_API_BASE_URL`

`STATUS_API_BASE_URL` 应该是 Worker API 域名，例如：

```text
https://api.status.example.com
```

Pages 项目名默认写死为 `router-vitals`。如果 Cloudflare Pages 项目使用其他名字，改 `.github/workflows/deploy-cloudflare.yml` 里的 `pages deploy` 命令。

## 首次部署顺序

先在 Cloudflare 创建：

- D1 数据库：`router-vitals`
- Pages 项目：`router-vitals`

然后在 GitHub 配好 Secrets 和 Variables，手动触发 `Deploy Cloudflare` workflow。
