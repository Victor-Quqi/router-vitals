# Claude 公益站状态监测想法

目标：做一个基于真实用户使用结果的公益站状态页，让大家能看到当前可用性、速度和主要错误类型。

## 基本思路

不做中转，不主动探测，不模拟 Claude Code。

用户仍然正常使用 Claude Code。通过 Claude Code plugin 接入 hooks，在真实请求成功或失败后，插件只收集状态元数据，然后匿名上报。

状态页展示的是“社区观测结果”，不是官方 SLA。

## 用户侧体验

用户安装插件后，仍然直接运行：

```bash
claude
```

插件做两件事：

- hooks：记录每轮真实使用的成功、失败、错误类型和延迟分桶。
- statusLine：在 Claude Code 底部显示当前社区状态和本机贡献状态。

示例效果：

```text
Claude 公益站: 可用 · 慢 · 贡献开启 · 今日 6 条
```

或：

```text
Claude 公益站: 不稳定 · server_error 偏高 · 今日 2 条
```

## 隐私边界

只上传白名单字段：

- 成功或失败
- 错误类型
- 模型种类
- 延迟分桶
- 时间分桶
- 插件版本
- 轮换的匿名 ID

不上传：

- prompt
- response
- token / cookie / key
- 账号信息
- session_id
- 完整日志
- 文件路径
- 精确时间戳

插件不读取 transcript 内容。最好提供本地预览，让用户能看到每次实际上报了什么。

## 服务端形态

第一版用 Cloudflare：

```text
Claude Code plugin
    -> Cloudflare Worker
    -> Cloudflare D1
    -> 状态页
```

Worker 负责接收匿名上报、字段白名单、限流和聚合。D1 存分钟级聚合数据，原始样本最多短期保留。

状态页展示：

- 最近 5 / 15 / 60 分钟可用性
- 样本数
- 延迟 p50 / p90
- 错误类型占比
- 置信度

样本不足时明确显示“样本不足”，不强行判断。

## 部署和迁移

主用：

- Cloudflare Pages 或 GitHub Pages：静态状态页
- Cloudflare Worker：上报和查询 API
- Cloudflare D1：聚合数据

备用：

- GitHub Pages：静态状态页
- Supabase Edge Function：上报和查询 API
- Supabase Postgres：聚合数据

插件不要写死具体云厂商，只认稳定域名和远程配置：

```text
api.status.example.com
config.status.example.com/config.json
```

以后 Cloudflare、Supabase、VPS 或其他 Serverless 之间切换时，只改 DNS 或远程配置，不要求用户重装插件。

## 超量策略

真正的扩容优先靠降采样，而不是马上迁移：

- 样本少：100% 上报
- 样本正常：部分抽样
- 样本很多：低比例抽样
- 后端压力大：只收失败样本和少量成功样本

长期只保留聚合数据，避免数据库和隐私压力。

## 项目定位

这是一个 Claude Code 使用体验的匿名众包状态页。

它不代理请求，不主动探测，不集中账号或 IP，不帮助绕过风控，只基于自愿用户的真实使用结果估算公益站可用性。
