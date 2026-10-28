# 国内五大影视平台播放页搜索 API

运行于 **Cloudflare Workers** 的统一 JSON 搜索接口，通过不完整片名、关键词搜索腾讯视频、爱奇艺、优酷、芒果 TV、哔哩哔哩的**官方网页播放地址**。

仓库包含 Worker 源码、OpenAPI 3.1 文档、自动测试、手动部署工作流和每周实测工作流。本次交付仅创建源码仓库，**尚未部署到 Cloudflare，也没有线上 API 域名**。

## 可用性说明

这些平台没有向本项目提供有 SLA 的五站统一搜索 API。原生入口属于公开网页或网页使用的接口，会改版、限流、验证和限制地区；本项目不能承诺“永久稳定”或每站都有结果。

采用以下方式提高可维护性：

- 五站独立适配和超时，单站失败不阻塞其他站点。
- 原生搜索优先；原生失败、分类不完整或无结果时，可使用 **Brave Web Search API** 备用源。它需要你自己的密钥和可用配额。
- 每站查询默认缓存 5 分钟；上游故障时，可回退到最近 24 小时缓存，并明确标记 `stale`。
- 严格校验官方域名和播放路径，排除搜索页、详情页、外站跳转、流媒体直链。
- 中文标题片段匹配、字符和双字片段相似度排序、URL 去重。不是语义检索，不保证所有错别字、同义词或跨语种名称都能匹配。
- 返回各站状态、来源、抓取时间和错误码；接口不把上游故障伪装成正常无结果。

最近一次环境实测见 [docs/validation.md](docs/validation.md)。实测只是该环境和时间的快照，不能代表 Cloudflare 出口或未来可用性。**无备用密钥时，当前不能保证五站全可用。** 备用源也会受索引覆盖、配额和服务状态影响；索引到的播放页可能已经下架。

仅做播放页链接发现，不解析 m3u8/mp4，不绕过付费或登录限制。访问链接时仍遵循平台的会员、版权和地区规则。结果可能包含预告、花絮、解说及不同版本，不保证均为正片。

## 平台标识

| 标识 | 平台 | 可返回的播放路径示例 |
| --- | --- | --- |
| `tencent` | 腾讯视频 | `v.qq.com/x/cover/...html`、`/x/page/...html` |
| `iqiyi` | 爱奇艺 | `www.iqiyi.com/v_...html` |
| `youku` | 优酷 | `v.youku.com/v_show/id_...html`、`/video?s=...` |
| `mango` | 芒果 TV | `www.mgtv.com/b/.../...html` |
| `bilibili` | 哔哩哔哩 | `/bangumi/play/ss...`、`/bangumi/play/ep...`、`/video/BV...` |

哔哩哔哩原生检索覆盖番剧和影视分类，搜索引擎备用源也可能返回普通视频。`kind=series` 表示整部或整季播放入口，`kind=video` 表示单个视频/分集页。

## 本地运行

需要 Node.js 24。

```bash
npm ci
cp .dev.vars.example .dev.vars
# 按需编辑 .dev.vars，填入 API_KEY 和 BRAVE_SEARCH_API_KEY
npm run dev
```

接口默认地址：`http://localhost:8787`。`.dev.vars` 已加入忽略列表，不要提交密钥。

```bash
curl --get 'http://localhost:8787/v1/search' \
  --data-urlencode 'q=三体' \
  --data-urlencode 'platforms=tencent,iqiyi,bilibili' \
  --data-urlencode 'limit=5' \
  -H "Authorization: Bearer $VIDEO_SEARCH_API_KEY"
```

未配置 `API_KEY` 时不需要认证头。

## 部署到 Cloudflare Workers

### 命令行

```bash
npm ci
npx wrangler login
npx wrangler secret put API_KEY
npx wrangler secret put BRAVE_SEARCH_API_KEY
npm run deploy
```

两个 Worker Secret 均可选；生产接入建议设置访问密钥和备用搜索密钥。Brave 密钥在 [Brave Search API 控制台](https://api-dashboard.search.brave.com/) 申请，需选择可访问 Web Search API 的方案。

无浏览器的部署环境可以配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。Token 需具有目标账户的 `Workers Scripts: Edit` 和 `Account Settings: Read` 权限。不要将 Token 写入配置文件或源码。Worker 默认名称是 `cn-video-search`，如账户内已有同名服务，请先修改 [wrangler.jsonc](wrangler.jsonc)。

部署命令成功后会打印真实的 `workers.dev` 地址；后续示例中的 `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` 都是占位符。

### GitHub Actions

1. 在仓库 **Settings → Secrets and variables → Actions** 配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 两个 Secrets。
2. 在 **Actions → Deploy Worker → Run workflow** 手动运行部署。工作流先执行类型检查、测试和构建。
3. 在 Cloudflare Worker 的 **Settings → Variables and Secrets** 配置 `API_KEY`、`BRAVE_SEARCH_API_KEY`，保存并应用到部署。
4. 将真实域名设为 GitHub Repository Variable `API_BASE_URL`，并将访问密钥设为 GitHub Secret `API_KEY`，即可启用每周一的线上搜索实测。未设置域名时该工作流跳过。

部署工作流不会自动同步运行时密钥，也不会因提交代码自动上线。推送只运行 CI；发布由你手动触发。

## API

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/search` | 模糊搜索播放页 |
| `GET /v1/platforms` | 平台名称与标识 |
| `GET /health` | Worker 进程健康检查，不检查外部平台 |
| `GET /openapi.json` | OpenAPI 3.1，支持导入 Apifox / Postman 等工具；仓库内也有 [静态文件](openapi.json) |

搜索参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `q` | 是 | 1–80 字符的片名或标题片段，自动统一全角和空格 |
| `platforms` | 否 | 默认 `all`，或逗号分隔的平台标识 |
| `limit` | 否 | 每站最多返回 1–20 条，默认 5 条；最多合计 100 条 |

认证：配置 `API_KEY` 后，使用 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`。密钥不接受 URL 参数。健康检查、平台列表和 OpenAPI 无需认证。

下面是单站查询的**结构示例**，并非线上响应或可用性证明：

```json
{
  "ok": true,
  "query": "三体",
  "partial": false,
  "total": 1,
  "took_ms": 260,
  "results": [
    {
      "platform": "tencent",
      "platform_name": "腾讯视频",
      "title": "三体 1",
      "url": "https://v.qq.com/x/cover/mzc002007knmh3g/i0045u918s5.html",
      "kind": "video",
      "score": 0.9267,
      "source": "native"
    }
  ],
  "providers": [
    {
      "platform": "tencent",
      "status": "ok",
      "count": 1,
      "warnings": [],
      "cached": false,
      "fetched_at": "2026-10-28T00:00:00.000Z",
      "search_url": "https://v.qq.com/x/search/?q=%E4%B8%89%E4%BD%93"
    }
  ]
}
```

`results[].url` 是接入使用的官方播放页地址。`providers[].search_url` 是给用户手动继续搜索的地址，不应当作播放链接。

`score` 是本地标题相关度分数，不是官方评分或置信概率。不会逐个访问结果验证此刻能否播放，否则会明显增加延迟、子请求数和被限流概率。

| 分站状态 | 含义 |
| --- | --- |
| `ok` | 原生搜索正常，或原生正常但为空时备用源找到结果 |
| `empty` | 原生搜索正常，但未找到符合播放路径与相关度要求的结果 |
| `degraded` | 原生入口或部分分类故障，已尝试备用源或保留可用分类结果；仍可能为空 |
| `unavailable` | 搜索不可用，没有可用结果或缓存 |
| `stale` | 上游异常，返回旧结果；检查 `fetched_at` |

`partial=true` 表示至少一站降级、不可用或使用旧缓存；接入方应展示可用结果，并按需提示。`HTTP 503` 仅在所有所选站都 `unavailable` 时返回，附 `Retry-After: 30`。正常无结果返回 `HTTP 200`。不要无限重试 `400`、`401`；上游异常建议使用退避重试。

## JavaScript 接入

```js
// 含密钥的请求建议由你的后端发起；不要在公开前端代码中写入共享密钥。
const base = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev';
const params = new URLSearchParams({ q: '三体', platforms: 'all', limit: '5' });
const response = await fetch(`${base}/v1/search?${params}`, {
  headers: { Authorization: `Bearer ${process.env.VIDEO_SEARCH_API_KEY}` },
  signal: AbortSignal.timeout(25000)
});
const data = await response.json();
if (!response.ok) throw new Error(data.error?.message || `搜索暂不可用：${response.status}`);
for (const result of data.results) console.log(result.title, result.url);
if (data.partial) console.log('部分站点降级：', data.providers);
```

## 配置与维护

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `API_KEY` | 无 | 可选访问认证，使用 Worker Secret |
| `BRAVE_SEARCH_API_KEY` | 无 | 可选备用搜索认证，使用 Worker Secret |
| `CORS_ORIGIN` | `*` | 允许的单一来源或 `*` |
| `CACHE_TTL_SECONDS` | `300` | 正常缓存时长，30–3600 秒 |
| `STALE_TTL_SECONDS` | `86400` | 故障回退窗口，最长 7 天，实际不小于正常缓存时长 |
| `UPSTREAM_TIMEOUT_MS` | `6000` | 每次上游请求超时，1000–10000 毫秒 |

Worker 无需 KV、D1 或 Node.js 兼容模式。使用 Cloudflare Cache API，缓存按数据中心存储，不保证常驻，也不会跨区域强一致；未命中时无法提供故障回退。当前没有内置跨请求全局限流，面向公众提供服务时，可通过 Cloudflare 的入口限流控制负载；备用搜索的配额也需要按流量配置。五站并行搜索可能并行触发备用请求；低 QPS 配额的 Brave 方案可能返回 `HTTP_429`。

```bash
npm run check       # TypeScript
npm test            # 不依赖外网的回归测试
npm run test:runtime # 真实 workerd 运行时：模拟上游，验证 fetch、缓存和认证
npm run build       # Worker 打包检查，不发布
npm run smoke       # 真实上游实测，生成 smoke-results.json；任一站无结果/失败则非零退出
npm run docs        # 根据源码重新生成静态 openapi.json
```

实测已部署的服务时设置 `API_BASE_URL` 和可选 `API_KEY`。受控代理环境运行 Node 实测时，可使用 `NODE_USE_ENV_PROXY=1 npm run smoke`；正常网络无需设置。

常见错误码：`HTTP_403` / `HTTP_401` 表示上游拒绝访问；`HTTP_412` 常见于风控；`HTTP_429` 表示配额或限流；`TIMEOUT` 表示超时；`SCHEMA_CHANGED` / `SCHEMA_OR_CHALLENGE` 表示响应结构变化或验证页。适配器位于 [src/providers.ts](src/providers.ts)，修改后应执行回归测试和真实实测。缓存中的旧 URL 不代表上游已恢复。

MIT License.
