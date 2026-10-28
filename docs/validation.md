# 验证记录

本次交付日期：2026-10-28。未连接、未部署到 Cloudflare。

## 代码验证

- `npm run check`：TypeScript 检查。
- `npm test`：19 项回归测试，包括参数校验、五站适配、URL 白名单、模糊排序、认证、超时、故障隔离、备用源过滤和缓存回退。
- `npm run test:runtime`：先打包，再在真实 workerd / Miniflare 运行时中使用模拟上游验证 fetch、响应流、认证及 Cloudflare Cache API。
- `npm run build`：Wrangler dry-run，验证 Worker 能打包，不会发布。

最终执行结果以仓库 CI 为准。真实站点的可用性独立于离线测试结果。

## 真实上游实测

命令：`NODE_USE_ENV_PROXY=1 npm run smoke`。在本次受控代理环境通过 Node 调用同一业务代码，未配置 Brave Search 密钥。完整时间戳、错误码和示例链接见 [原始 JSON](live-smoke-2026-10-28.json)。

| 平台 | 本次状态 | 说明 |
| --- | --- | --- |
| 腾讯视频 | 返回结果 | 官方搜索 API 返回播放页 |
| 爱奇艺 | 返回结果 | 官方搜索 API 返回播放页 |
| 优酷 | 不可用 | HTTP 200 但内容为验证页，返回 `SCHEMA_OR_CHALLENGE` |
| 芒果 TV | 不可用 | 官方网页使用的搜索入口返回 HTTP 401 |
| 哔哩哔哩 | 部分降级，仍返回结果 | 一个分类返回 HTTP 412，另一个分类有结果 |

因此 `npm run smoke` 返回非零退出码：**当前没有证明五站全部可用**。初次探测时优酷曾返回包含链接的完整 HTML，后续探测出现验证页；这也是不能承诺永久稳定的具体证据。平台返回结果不代表页面此刻必然可以播放。

Brave 备用源已通过模拟响应测试，过滤非官方链接并正确处理限流，但没有真实密钥，因此**未完成备用源的线上实测**。

## Worker 运行环境

本地 `wrangler dev` 的健康检查、平台列表、OpenAPI 和非法参数返回已验证。真实外部调用在该本地运行时出现 `NETWORK_ERROR` / `TIMEOUT`，与通过受控代理运行的 Node 结果不同；不能据此声称 Cloudflare 出口已验证可用。

额外使用 workerd / Miniflare 和受控模拟上游测试 Worker 的请求、流读取、认证与真实 Cache API，避免仅依赖 Node 单测。未来实际部署后，仍需使用 `API_BASE_URL=https://实际域名 npm run smoke` 验证 Cloudflare 出口的各站结果，并在需要时配置备用搜索源。
