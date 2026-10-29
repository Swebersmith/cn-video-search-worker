# VideoSearch · 五站统一查询接口

Cloudflare Workers 上的影视官方播放页发现服务。**一个聚合接口、五个单站接口，同一套参数与返回结构。** 默认综合模式合并搜索结果与已接入的分集目录，按 URL 去重，保留集数编号。

- [接口说明与在线调试](https://videosearch.webber.qzz.io/)
- [OpenAPI 3.1](https://videosearch.webber.qzz.io/openapi.json) · [平台能力清单](https://videosearch.webber.qzz.io/v1/platforms)
- [服务健康检查](https://videosearch.webber.qzz.io/health)，只检查 Worker，不检查上游。

## 接口结构

统一请求路径中的 `q` 为必填关键词，以下示例均默认 `mode=all`。

| 接口 | 路径 | 行为 |
| --- | --- | --- |
| 聚合总接口 | `/v1/search?q=海市蜃楼` | 并行查询五站，聚合结果 |
| 腾讯视频 | `/v1/tencent/search?q=海市蜃楼` | 仅腾讯视频内容 |
| 爱奇艺 | `/v1/iqiyi/search?q=海市蜃楼` | 仅爱奇艺内容，支持电视剧分集目录 |
| 优酷 | `/v1/youku/search?q=海市蜃楼` | 仅优酷内容 |
| 芒果 TV | `/v1/mango/search?q=海市蜃楼` | 仅芒果 TV 内容 |
| 哔哩哔哩 | `/v1/bilibili/search?q=海市蜃楼` | 仅哔哩哔哩内容 |

聚合接口与单站接口调用同一份平台查询逻辑，不通过外部 HTTP 请求再调用自己的接口。单站接口不接受 `platforms`，保证不会查询或返回其他网站。

### 三种功能模式

| mode | 行为 |
| --- | --- |
| `all` | 默认：合并普通搜索和已接入的分集目录。相同 URL 只返回一次，分集信息优先。 |
| `search` | 只做普通模糊搜索，不请求分集目录。 |
| `episodes` | 只请求已接入的分集目录；暂未接入的站点返回 `unsupported`。 |

当前五站都接入普通搜索；**完整分集目录当前仅接入爱奇艺电视剧**。其他站点没有完整目录适配器，不会拿搜索片段冒充全集。平台风控、地区限制和改版仍会影响实际可用性；不承诺五站始终可用。

原 `/v1/episodes` 保留历史返回格式并添加 `Deprecation` 响应头，只用于旧接入兼容。新接入请使用上述统一接口的 `mode` 参数。

## 参数

| 参数 | 默认值 / 范围 | 说明 |
| --- | --- | --- |
| `q` | 必填，1—80 字符 | 片名或标题片段；自动统一全角和空格。 |
| `mode` | `all` | `all`、`search`、`episodes`，总接口和单站接口一致。 |
| `platforms` | `all` | **仅聚合接口**：逗号分隔的标识子集，例如 `tencent,iqiyi`。 |
| `limit` | `5`，1—20 | 每站普通搜索上限；**不会截断分集目录**。 |
| `album_id` | 可选，数字 | 爱奇艺同名电视剧专辑选择；要求 `mode=all/episodes` 且查询范围包含爱奇艺。 |

```text
https://videosearch.webber.qzz.io/v1/search?q=海市蜃楼
https://videosearch.webber.qzz.io/v1/iqiyi/search?q=海市蜃楼
https://videosearch.webber.qzz.io/v1/iqiyi/search?q=海市蜃楼&mode=episodes
https://videosearch.webber.qzz.io/v1/search?q=三体&platforms=tencent,iqiyi&mode=search&limit=10
```

`limit=5` 并不表示一部剧只有 5 集。综合查询里爱奇艺正片目录可返回 24 集，加上其他站搜索结果；`total` 是最终去重结果数，不是电视剧总集数。

## 返回结构

- `results[].url`：官方播放页地址；不包含流媒体直链。
- `platform`：内容来源；`content_type` 为 `search` 或 `episode`。
- 分集结果包含 `episode_number`、`album_id`、`series_title`，每站内部按集数排序。
- `providers[]`：各站整体状态、去重后条数，以及 `operations.search`、`operations.episodes` 两个功能各自的状态、条数、缓存时间和警告。
- `providers[].catalog`：所选专辑和候选专辑、`expected_total`、`complete`、`missing_episode_numbers`。仅目录存在时返回；具体链接统一在顶层 `results`。
- `available_count` / `truncated` 仅描述普通搜索候选及搜索上限，不表示目录完整性。
- `partial=true` 表示至少一站降级、不可用或所选功能未接入，应查看分站状态，不要丢弃其他站成功的结果。

`complete=true` 仅在官方目录读取成功、声明的总集数一致、编号和链接校验齐全时出现。目录最多读取 500 集；超出上限、缺集或使用搜索预览降级时明确标为不完整。目录完整不代表免会员或每个页面此刻都能播放。

### 状态与认证

| HTTP 状态 | 含义 |
| --- | --- |
| 200 | 查询完成，包括正常无结果或部分降级。 |
| 400 | 参数错误。 |
| 401 | 配置了访问密钥，但请求未通过认证。 |
| 422 | 所选站点均未接入请求的功能。 |
| 503 | 所选站点本次全部不可用，无可用结果。 |

当前部署未配置 `API_KEY`，可直接调用。设置后，查询接口必须使用 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`；不接受 URL 密钥。说明页面、OpenAPI、能力清单和健康检查保持公开。

在线调试在当前域名发送请求，密钥仅在页面内使用，不写入 URL、存储或复制的命令。复制 cURL 使用密钥占位符。对外服务建议在自己的后端保管共享密钥。

## 本地运行和部署

需要 Node.js 24。

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

本地地址 `http://localhost:8787` 包含说明页及所有 API。`.dev.vars` 已忽略，按需填入访问密钥和备用搜索密钥。

```bash
npx wrangler login
npx wrangler secret put API_KEY
npx wrangler secret put BRAVE_SEARCH_API_KEY
npm run deploy
```

两个 Secret 均可选。Brave Web Search API 备用源在原生搜索失败、不完整或无结果时使用，需要自己的有效密钥及配额。它不会作为完整分集目录的依据。

当前域名通过 `wrangler.jsonc` 的 `routes` 保持绑定；复制项目到其他账户时，请换成自己的域名或移除 `routes` 使用部署返回的 `workers.dev` 地址。原地址 `https://cn-video-search.382990094xwb.workers.dev` 仍可用。

GitHub 仓库包含 CI、手动部署和每周实测工作流。当前部署使用 Cloudflare 已授权连接；GitHub Actions 的部署 Secrets 和实测变量尚需仓库管理员配置：

1. 设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` Secrets，然后手动运行 **Deploy Worker**。Token 使用目标账户的 Workers Scripts: Edit 和 Account Settings: Read 权限。
2. 将 Repository Variable `API_BASE_URL` 设为正式域名，按需设置 `API_KEY` Secret，启用每周真实搜索实测。未设置地址时跳过。

## 缓存、维护和验证

Worker 无需 KV 或 D1，使用按数据中心存储的 Cache API。普通搜索默认缓存 5 分钟，上游故障时可回退到最近 24 小时缓存并标记旧数据；分集目录只缓存完整结果。综合查询会共享同一请求中的爱奇艺搜索数据，避免搜索和目录重复拉取。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `API_KEY` | 无 | 可选访问认证，使用 Worker Secret。 |
| `BRAVE_SEARCH_API_KEY` | 无 | 可选备用搜索密钥，使用 Worker Secret。 |
| `CORS_ORIGIN` | `*` | 允许的来源。 |
| `CACHE_TTL_SECONDS` | `300` | 正常缓存时长，30—3600 秒。 |
| `STALE_TTL_SECONDS` | `86400` | 普通搜索故障回退窗口，最长 7 天。 |
| `UPSTREAM_TIMEOUT_MS` | `6000` | 每次上游请求超时，1000—10000 毫秒。 |

```bash
npm run check
npm test              # 单站隔离、聚合、目录及页面交互等回归测试
npm run test:runtime  # 真实 workerd，使用受控模拟上游
npm run docs          # 重新生成 OpenAPI 静态文件
npm run smoke         # 原生搜索实测，任一站无结果/失败则非零退出
```

通过 `API_BASE_URL=https://videosearch.webber.qzz.io npm run smoke` 实测线上；受控代理环境可加 `NODE_USE_ENV_PROXY=1`。完整验证记录见 [docs/validation.md](docs/validation.md)。

上游可能出现 `HTTP_401/403/412/429`、`TIMEOUT`、`SCHEMA_OR_CHALLENGE` 等错误。当前没有跨请求全局限流，请按服务流量配置入口限流和备用源配额。默认 Python `urllib` 访问 `workers.dev` 若遇 Cloudflare 1010，请设置描述性 User-Agent，参见 [官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)。

MIT License.
