# VideoSearch · 五站剧集与分集目录

Cloudflare Workers 上的影视官方播放页发现服务。**一个聚合接口、五个单站接口，先返回剧集列表，再展开所选作品的分集目录。** 同名作品、年份和不同版本按平台 ID 分开，不再默认展开搜索到的第一部剧。

- [说明页面与在线调试](https://videosearch.webber.qzz.io/)：选择总接口或单站，搜索后点击“展开分集”。
- [OpenAPI 3.1](https://videosearch.webber.qzz.io/openapi.json) · [平台能力](https://videosearch.webber.qzz.io/v1/platforms) · [健康检查](https://videosearch.webber.qzz.io/health)

## 两层查询

| 用途 | 路径 | 内容 |
| --- | --- | --- |
| 聚合总接口 | `/v1/search?q=三体` | 并行搜索五站，聚合剧集摘要 |
| 腾讯视频 | `/v1/tencent/search?q=三体` | 仅腾讯剧集 |
| 爱奇艺 | `/v1/iqiyi/search?q=海市蜃楼` | 仅爱奇艺剧集 |
| 优酷 | `/v1/youku/search?q=甄嬛传` | 仅优酷剧集 |
| 芒果 TV | `/v1/mango/search?q=歌手2025` | 仅芒果作品 |
| 哔哩哔哩 | `/v1/bilibili/search?q=三体` | 仅哔哩哔哩番剧 / 影视作品 |
| 指定作品目录 | `/v1/{platform}/series/{id}?q=原关键词` | 精确选择某部作品的分集目录 |

搜索默认 `view=series`，返回多个作品的摘要。每项包含 `platform`、`id`、`title`、`year`、`type_name`、`total_episodes`、`url` 和 **`detail_url`**。客户端应直接跟随 `detail_url`，保留其中的 `q` 提示，避免自行推测不同平台的 ID 格式。优酷冷缓存目录需要通过该关键词取得准确 showId 对应的 SSR 数据。

```text
GET /v1/iqiyi/search?q=海市蜃楼
→ results[0].detail_url
GET /v1/iqiyi/series/6244560312265801?q=海市蜃楼
→ episodes[0..23]，complete=true
```

总接口和单站接口直接调用同一份业务逻辑；单站不接受 `platforms`，也不会把外站跳转链接标成本平台内容。只做剧集发现时不会预先向所有匹配剧集拉取目录。

### 参数

| 参数 | 默认值 / 范围 | 说明 |
| --- | --- | --- |
| `q` | 1—80 字符，搜索必填 | 模糊片名。目录请求应保留 `detail_url` 中的原关键词。 |
| `view` | `series` | `series` 返回剧集摘要；`videos` 保留旧版扁平链接。 |
| `platforms` | `all` | 仅聚合接口：逗号分隔的平台标识子集，如 `tencent,iqiyi`。 |
| `limit` | `5`，1—20 | 每站最多返回多少部作品，**不截断点击后的分集目录**。 |

搜索 `total` 是本次返回的剧集条数，`providers[].total` 是本次发现的候选数；`truncated` 表示被 limit 截断。它们都不是电视剧总集数。上游搜索并不保证发现整个站点的全部作品。

### 目录响应

- `series`：准确选中的作品摘要。
- `episodes[]`：官方播放页链接，包含 `episode_number`（无法可靠判断则为 null）、`title`、`url`、`platform`、`episode_type`（`main` / `extra`）。按集数排序，附加内容单列在后。
- `total` / `main_total` / `extra_total`：实际返回的全部目录条数、主目录条数、附加内容条数。主目录可能包含上下部或语言版本，不一定等于连续剧的集数。
- `expected_total`：上游当前目录的预期条数，包含该来源计入的附加内容；未知时为 null。
- `complete` / `partial` / `missing_episode_numbers` / `warnings`：是否与该来源当前目录一致，是否存在缺集或上游故障。
- `source` / `fetched_at` / `cached`：来源、读取时间与缓存状态。

`complete=true` 要求来源验证、分页完成、条数与编号检查通过；不代表未来尚未发布的分集、免会员或每页必然可播放。预览降级、缺集、分页失败或冲突都不会标为完整。搜索标注的 `series.total_episodes` 可能含彩蛋或不同版本，保留原值供比较。

### 五站目录来源

| 平台 | 剧集发现 | 目录与过滤 |
| --- | --- | --- |
| 爱奇艺 | 官方 mesh 搜索中的电视剧专辑 | pcw avlist，校验 albumId，正片 contentType，最多 500 集 |
| 腾讯视频 | 官方 MultiTerminalSearch 的自有播放站点 | PageServer 选集，校验 cid，保留彩蛋并标为 extra，最多 5 页 |
| 优酷 | 官方搜索页的 `__INITIAL_DATA__` JSON，网页受限时使用官方 JSON 搜索 | 按 showId 约束正片节点；搜索仅返回预览时使用官方 `show_episode` 选集 API，校验作品 ID 与集数 |
| 芒果 TV | 原生搜索，受限时使用腾讯公开索引中的芒果官方链接 | 芒果 episode/list，按 clip ID 校验、一基分页，最多 10 页；保留期数、加更和版本原始标题 |
| 哔哩哔哩 | 官方番剧 / 影视分类搜索，失败时尝试综合搜索 | 官方 season 目录，失败时尝试 main_section；校验 season_id / 分区 ID，过滤预告分区和预告标记 |

上游风控、地区限制和改版仍影响实际可用性。优酷可能返回验证页面，哔哩哔哩可能返回 412，芒果原生搜索可能返回 401；这些都会暴露为 warnings / unavailable，不返回伪造目录。适配器已实现不等于任意时刻、任意作品都有可用目录。服务只提供官方播放页，不解析媒体流。

## 兼容旧接入

显式 `view=videos` 或携带旧 `mode=all/search/episodes` 参数时，保留旧扁平 `results` 格式。旧 `all` 合并普通搜索和爱奇艺目录，旧 `episodes` 仅爱奇艺。`album_id` 也只在旧模式中使用。原 `/v1/episodes` 保留并带 `Deprecation` 响应头。**新接入统一使用摘要 → detail_url 的五站目录流程。**

## 状态、认证和页面

200 表示请求完成，仍需检查 partial；400 为参数错误，401 为认证失败，503 为本次没有可用上游结果 / 目录。单站失败时总接口保留其他站的结果。

当前部署未配置 `API_KEY`，可直接调用。配置后使用 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`；不接受 URL 密钥。说明页、OpenAPI、能力清单和健康检查公开。

在线调试只请求当前域名，密钥仅通过请求头传递，不写入 URL、存储或复制的命令；复制 cURL 使用占位符。目录展开保持版本 ID 和认证信息，结果使用安全的 DOM 文本及官方域名链接。

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

### GitHub 推送后自动部署

现有 Worker 已通过 **Cloudflare Workers Builds** 连接 `Swebersmith/cn-video-search-worker`。向 `main` 推送或合并修改后，会自动安装依赖、检查、测试并部署到 `cn-video-search`；无需每次手动发布或在 GitHub 中保存 Cloudflare Token。

| 设置 | 当前值 |
| --- | --- |
| 生产分支 | `main` |
| 根目录 | `/` |
| Node.js | `24` |
| 构建命令 | `npm run check && npm test && npm run test:runtime` |
| 部署命令 | `npm run deploy -- --keep-vars` |
| 非生产分支预览 | 关闭，不会发布到生产 |

检查或测试失败时不会执行部署命令，线上继续运行上一个成功版本。`--keep-vars` 保留控制台设置的变量，Secret 由 Cloudflare 管理；自定义域名由仓库内 `wrangler.jsonc` 保持绑定。

在 Cloudflare 控制台选择 `cn-video-search` → **Settings → Builds** 查看仓库连接、构建历史和日志。完整操作说明见 [持续部署说明](docs/continuous-deployment.md)，配置记录见 [cloudflare-builds.json](docs/cloudflare-builds.json)。

### GitHub Actions（检查与备用部署）

GitHub 的 CI 仍会在提交和 PR 时执行检查，与 Workers Builds 的生产部署独立。原手动部署工作流仅作为备用，正常更新无需运行。若需要使用备用流程或每周上游实测，可配置：

1. 备用部署：设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` Secrets，然后手动运行 **Deploy Worker**。Token 使用目标账户的 Workers Scripts: Edit 和 Account Settings: Read 权限；已有自定义域名时还需满足相应域名路由权限。
2. 将 Repository Variable `API_BASE_URL` 设为正式域名，按需设置 `API_KEY` Secret，启用每周真实搜索实测。未设置地址时跳过。

## 缓存、维护和验证

Worker 无需 KV 或 D1，使用按数据中心存储的 Cache API。剧集发现默认缓存 5 分钟，分集目录只缓存完整结果，两类缓存相互独立。旧版普通链接搜索保留最近 24 小时的故障回退，明确标记旧数据。

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
