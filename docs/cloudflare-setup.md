# Cloudflare 从零配置

这套项目需要 Cloudflare Workers、D1、Pages。先不用本地装 Wrangler，直接用 GitHub Actions 部署。

## 1. 创建 D1

Cloudflare Dashboard 里进入：

```text
Workers & Pages -> D1 -> Create database
```

数据库名填：

```text
router-vitals
```

这个名字来自 `site.config.json` 的 `cloudflare.d1Name`。

创建后复制 database ID，后面填到 GitHub Variables：

```text
CLOUDFLARE_D1_DATABASE_ID
```

## 2. 创建 Pages 项目

进入：

```text
Workers & Pages -> Create -> Pages
```

项目名填：

```text
router-vitals
```

这个名字来自 `site.config.json` 的 `cloudflare.pagesProject`。

首次可以先建空项目；后续 GitHub Actions 会用：

```text
wrangler pages deploy status-page --project-name=router-vitals
```

如果你想换项目名，改 `site.config.json` 后运行 `pnpm run sync:site`。

## 3. 创建 API Token

进入：

```text
My Profile -> API Tokens -> Create Token -> Custom token
```

权限给这些：

```text
Account / Workers Scripts / Edit
Account / D1 / Edit
Account / Cloudflare Pages / Edit
```

资源范围选你的账号。创建后复制 token，填到 GitHub Secrets：

```text
CLOUDFLARE_API_TOKEN
```

## 4. 复制 Account ID

Cloudflare Dashboard 右侧或账号首页能看到 Account ID。填到 GitHub Secrets：

```text
CLOUDFLARE_ACCOUNT_ID
```

## 5. 配 GitHub

GitHub 仓库进入：

```text
Settings -> Secrets and variables -> Actions
```

Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Variables：

```text
CLOUDFLARE_D1_DATABASE_ID
STATUS_API_BASE_URL
```

第一次没有自定义域名时，`STATUS_API_BASE_URL` 先填 Worker 部署后的默认域名会更准确。首次部署前还不知道默认域名，可以先填占位值：

```text
<worker-api-origin>
```

首次部署完成后，到 Cloudflare Workers 页面确认实际 URL，再回 GitHub Variables 修正，然后重新跑一次 `Deploy Cloudflare`。

## 6. 首次部署

GitHub 里进入：

```text
Actions -> Deploy Cloudflare -> Run workflow
```

成功后会完成：

- D1 migration
- Worker 部署
- Pages 部署

## 7. 绑定正式域名

推荐域名：

```text
api.status.example.com    -> Worker
status.example.com        -> Pages
config.status.example.com -> Worker 的 /config.json 或 /v1/config，或单独静态 JSON
```

如果 Cloudflare 托管你的 DNS：

- Worker：进入 Worker -> Settings -> Triggers -> Custom Domains。
- Pages：进入 Pages project -> Custom domains。

然后把 GitHub Variable `STATUS_API_BASE_URL` 改成正式 API 域名：

```text
<worker-api-origin>
```

重新跑一次 `Deploy Cloudflare`，让状态页里的 `status-page/config.js` 写入正式 API 地址。

## 8. 检查

部署后访问：

```text
<worker-api-origin>/config.json
<worker-api-origin>/v1/config
<worker-api-origin>/v1/status?window=15m
```

`/config.json` 和 `/v1/config` 应该对应 Any Router 两个目标端点：

```text
主站直连
大陆优化
```

`/v1/status` 在没有样本时会返回 `insufficient_data`。
