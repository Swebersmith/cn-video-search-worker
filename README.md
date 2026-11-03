# VideoSearch · 五站官网搜索、AI 目录与官采资源站

正式地址：<https://videosearch.webber.qzz.io/> · [OpenAPI](https://videosearch.webber.qzz.io/openapi.json)

共有三种使用方式：官网综合搜索、影视目录、第三方官采资源站。官网前两种使用 view 参数；第三方使用独立路径。在线文档的[模式使用指南](https://videosearch.webber.qzz.io/#modes)分别说明调用步骤、参数与结果读取方式。

| 模式 | 请求示例 | 行为 |
| --- | --- | --- |
| 官网综合搜索 | `/v1/search?q=嫁金钗&view=official&page=1` | 默认模式，保留官网本页全部卡片和顺序，以及原始响应。 |
| 影视目录 | `/v1/search?q=嫁金钗&view=series&limit=5` | 先返回电影、长电视剧、综艺、动漫、纪录片摘要，选择后请求 detail_url 读取分集；AI 辅助分类和识别，排除短剧与普通短视频。 |
| 官采资源站 | `/v1/resources/search?q=三体&sources=all&page=1` | 独立搜索 KV 中已启用的第三方来源；返回条目与线路，详情使用该结果的 detail_url。 |

单站路径为 `/v1/{platform}/search`，平台标识：`tencent`、`iqiyi`、`youku`、`mango`、`bilibili`。例如：

```text
GET /v1/youku/search?q=嫁金钗&view=series&limit=5
→ 用 results[] 中的 platform、id、year、type_name 展示作品选项
→ 用户选择后，原样请求该条 detail_url（保留它的 q 参数）
→ 详情读取 all_episodes 获取正片、附加内容和预告的完整合并列表
```

`results[]` 中搜索到 6 个条目不表示电视剧只有 6 集。官网综合搜索返回本页卡片，影视目录搜索返回作品摘要，都不是完整分集。需要分集时先用 `view=series` 选作品，再请求 `detail_url`。第三方搜索条目可已有 `lines[]`，详情条目位于 `item`，分集在 `item.lines[].episodes`，预告在 `item.lines[].previews`。

例如，只查看爱奇艺官网第 2 页可请求 `/v1/iqiyi/search?q=三体&view=official&page=2`；只查腾讯与优酷可请求 `/v1/search?q=三体&view=official&platforms=tencent,youku&page=1`。第三方只查金蝉使用 `/v1/resources/search?q=三体&sources=jinchan&page=1`，来源 ID 通过 `/v1/resources` 获取。

以下命令可直接调用；片名由 curl 编码，后续更换关键词不需要手工拼接中文 URL：

```bash
curl --get 'https://videosearch.webber.qzz.io/v1/tencent/search' \
  --data-urlencode 'q=三体' \
  --data-urlencode 'view=series' \
  --data-urlencode 'limit=5'
```

如已配置公共接口 API_KEY，追加 `-H 'Authorization: Bearer YOUR_API_KEY'`；不要使用管理密钥，也不要把密钥放进 URL。同一请求头也应传给详情请求。

官网接口的 `view` 只允许 `official` / `series`；不要传 `view=resources`，请改用 `/v1/resources/search`。旧版链接模式和专辑选择接口已移除，旧参数返回 400，移除的路径返回 404。

## 参数与返回

| 参数 | 范围 | 用途 |
| --- | --- | --- |
| `q` | 1—80 字符，搜索必填 | 模糊片名；目录请求保留 detail_url 中的关键词提示。 |
| `view` | `official` / `series` | 默认 official。 |
| `page` | 1—1000，默认 1 | official 及资源站搜索的上游页码；series 搜索携带会返回 400，详情不支持。 |
| `limit` | 1—20，默认 5 | 仅 series，限制每站作品数，不截断展开的目录。official 忽略此参数。 |
| `platforms` | all 或逗号分隔平台标识 | 仅官网总接口 /v1/search，单站和资源站不支持。 |
| `sources` | all 或逗号分隔来源 ID | 仅 /v1/resources/search，默认为 KV 中全部启用来源。 |

官网模式每次读取本页真实官网响应，不进行 AI 改写、相关度重排、去重或目录类型过滤。`results[].raw` 保留完整卡片，`providers[].upstream` 保留官方原始响应。官网自己收录的外站卡片仍保留为原始数据；本服务不会调用别站搜索代替该站。

目录模式的摘要包含 `id`、`title`、`year`、`category`、`type_name`、`total_episodes`、`detail_url`。分类只允许 `movie`、`tv`、`variety`、`anime`、`documentary`；作品长短依据内容类型，不凭集数多就把短剧当成长电视剧。芒果只将官网 program 等作品卡片作为候选，不把标了“电视剧”的几十秒路透视频当成正剧。

目录详情包含：

- `episodes[]`：唯一分集列表，包含正片、预告和附加内容，带 `episode_number`、`title`、官方 `url`、`episode_type`（main / extra / preview）和 `badges`。
- `badges[]`：官网角标原文，例如 VIP、SVIP、预告、收官礼、超前点映；页面在每条分集右上角展示，不根据付费状态猜测会员等级。
- 同集已有正片时不再返回该集预告；周预告等无具体集号的预告保留。移除旧 `previews`、`all_episodes`、`all_total` 字段，客户端直接读取 `episodes`。
- `total` 等于 `episodes.length`；`main_total` / `extra_total` / `preview_total` 分别统计正片、附加内容、保留的预告。完整性按正片和附加目录核验，预告不充当正片。
- 五个平台均读取官方播放页中的作品选集，并结合播放器使用的官方选集 API 补齐动态选集或分页；无法读取时在 `warnings` 保留 `playback:` 原因。只采集所选作品的选集模块，不采集推荐栏。
- `expected_total`：官方当前发布范围对应的目录条数；计划全集数仍在 `series.total_episodes`。
- `missing_episode_numbers`：当前已发布范围内没有找到链接的编号。
- `unavailable_episode_numbers`：已找到预告，但正片尚未确认的编号；与缺失链接分开显示。
- `update_notice`：官方更新说明。`complete` / `partial` / `warnings` 表明本次目录是否取齐、是否存在上游限制。
- `ai`：AI 状态、模型、分类数、实际补充条数和错误代码。

《嫁金钗》的搜索选集 API 曾只提供 26 集正片，播放页提供 30 集。服务合并播放页后保留第 27—30 集“收官礼”标记，并隐藏同集预告；无具体集号的周预告仍保留。

`complete=true` 要求来源、分页、当前条数和编号校验通过，不表示全剧完结、免会员或每页必然可播放。

## DeepSeek 辅助处理

目录默认 `ai=off`，完全不调用 AI；`ai=on` 启用辅助分类与复核。两者缓存隔离，搜索结果的 `detail_url` 保留选择。官网综合搜索和资源站模式不使用 AI，不接受 `ai` 参数。

示例：`/v1/youku/search?q=嫁金钗&view=series&ai=off`；启用时将 off 改为 on。

默认模型为 `deepseek-flash`，服务端调用 DeepSeek 的 JSON 输出接口，关闭思考模式以降低交互等待。目录查询中的作品标题、官方类型和精简候选标签会发送给 DeepSeek；访问密钥不进入模型提示、前端、URL、日志或 GitHub。

分类结合官方类型与 AI 判断。官方明确为短剧、陪看、剪辑等内容时，模型不能将其提升为长影视作品。AI 不可用时使用有明确依据的类型规则；无法确认的类型不进入目录，并在 `ai.status=fallback` 和 warnings 中说明。

从官方响应提取候选并校验作品归属和官方播放路径，保留原始标题、章节、角标、时长及预告标记（包括腾讯字符串形式的 `is_trailer`）。明确预告以 `episode_type=preview` 进入统一 `episodes` 列表；VIP / 抢先看角标不会直接被当成预告。

AI 协助核对候选的集序与标题，**只返回候选编号，不输出 URL**。只有官网明确标为预告的条目才可标为 preview，模型不能自行推断“隐藏预告”。VIP、SVIP、提前看、抢先看、超前点映、付费或试看限制不代表预告；不会因时长短、编号重复、搜索总数滞后或 AI 不可用而隐藏官网已编号的正片 URL。同集不同版本的链接全部保留，仅按相同 URL 去重；编号冲突仍返回 `CONFLICTING_EPISODE_NUMBERS` 并将完整性标为待确认。复核不完整返回 `AI_EPISODE_AUDIT_PARTIAL`。

《走马上任》的腾讯官方样本包含 5 条正片与 6 条预告：修复后正片只列第 1—5 集，仅保留第 6、7 集预告，与正片统一返回，第 6、7 集标为正片待确认。腾讯搜索总数包含预告占位；仅在官方返回条目能完整解释该总数时，按实际正片、附加条目及仅有预告的编号校正 `expected_total`。

作品摘要和分类默认缓存 5 分钟；完整目录单独缓存。AI 请求有超时、响应大小和候选数量上限。使用已有 `API_KEY` 认证可控制共享接口访问；AI 调用使用你自己的 DeepSeek 配额。

## 官采资源站搜索

页面“功能模式”选择“官采资源站”，可指定来源并分页搜索。API 示例：

```text
GET /v1/resources
GET /v1/resources/search?q=走马上任&sources=jinchan&page=1
GET /v1/resources/search?q=三体&sources=jinchan,tw&page=2
GET /v1/resources/jinchan/items/105662
```

`sources=all` 搜索 KV 中全部**已启用**来源。默认启用 `jinchan` 金蝉官采、`tw` TW 官采；另预置停用的 `jinying` 金鹰资源、`ruyi` 如意资源，两者主要返回第三方播放页或媒体地址，可在管理页自行启用。2026-11-03 已移除返回 302 / 403 / 526 / 530 的 789、虾米、奈斯、8090、官方采集、建安六个失效默认来源。

每次搜索的 `providers` 分别给出状态、警告、上游总数、分页及来源 URL。HTML 占位页、超时、错误分页或忽略关键词的接口不会被当成成功搜索，全部来源不可用时返回 503。全部停用时返回 200 和空结果，不会恢复默认来源。第三方服务可能随时变更，以本次请求和管理页测试为准。

结果注明 `source=third_party`、`source_id`、`source_name`，不会作为官网搜索的兜底。`detail_url` 读取准确条目的线路。MacCMS JSON 与 RSS XML 的播放来源和分集字段规范化为 `lines[]`，每条线路提供 `episodes` / `previews`；保留 SVIP、抢先看等分集标签。`link_type` 区分 `official_page`、`media`、`external_page`，`playback_verified=false` 表示未验证播放能力。服务不调用第三方解析线路或媒体地址，不将来源名称当成平台授权证明。页面可点击官方播放页，其他地址以文本展示。

仅调用 KV 中启用的来源；公共搜索不接受临时 API 地址。启用 `API_KEY` 后搜索与详情沿用同一认证。关键词与页码分别传给上游 `wd` / `pg`，详情使用 `ids`；JSON / XML 字段解析有大小和条数上限。

### 采集站管理与 KV

打开 `/admin`，使用独立的 `RESOURCE_ADMIN_KEY` 登录，可新增、编辑、删除、启停来源，也可先测试草稿接口再保存。页面从 KV 读取全部来源，搜索页下拉框从 `/v1/resources` 动态读取已启用项。管理密钥仅保留在当前页面内存，不进入 URL、本地存储或第三方请求。它与可选的公共接口 `API_KEY` 分开，管理写入不会因公共接口未设密钥而开放。

- `GET /v1/admin/resource-sources`：读取全部来源、`revision` 与保存时间。
- `PUT /v1/admin/resource-sources`：JSON `{ "revision": "读取的版本", "sources": [{ "id": "custom1", "name": "自定义站", "endpoint": "https://your-source.com/api.php/provide/vod/", "enabled": true }] }`，整份替换配置；请求头 `X-Admin-Key`。
- `POST /v1/admin/resource-sources/check`：JSON `{ "source": { ...同上 }, "q": "三体" }`，核对搜索、准确 ID 详情、随机关键词空结果和不同分页，返回 `healthy` / `checks` 和官方页、媒体、外部页计数；不保存配置，不测试播放能力。

`RESOURCE_CONFIG` 绑定 Cloudflare Workers KV，键为 `resource-sources:v1`。最多 20 个来源、请求体 64 KiB，只接受公共 HTTPS 域名下的 MacCMS `provide/vod` 接口（JSON 或 RSS XML），不接受 URL 密钥或内网地址。保存失败会明确报错；KV 配置损坏时不会静默恢复已删除来源。无 KV 或空键时才使用代码预置值，绑定缺失时禁止保存。

KV 是最终一致存储，跨地区通常需 30–60 秒或更久传播。管理页保存后立即使用保存响应中的配置；`revision` 可发现已读取到的版本冲突，但不是强一致锁，请避免同时编辑。推送 GitHub 更新不会覆盖 KV 中已保存的自定义来源。

新部署先在 Cloudflare 创建 KV namespace，在 `wrangler.jsonc` 配置 `RESOURCE_CONFIG` 的 namespace ID，并将至少 12 字符（建议 32 字符以上随机值）的 `RESOURCE_ADMIN_KEY` 添加为 Worker Secret。当前仓库已绑定此项目的生产 namespace，其他账号部署需替换 ID。GitHub 自动构建使用 `--keep-vars` 保留 Secret。

## 官网来源（原接口）

腾讯使用官方 MultiTerminalSearch；爱奇艺使用 mesh 搜索和专辑目录；优酷使用官方搜索与 show_episode API；芒果使用官网 search/v2 和 episode/list；B站使用官网 SSR、综合搜索和 season / section 目录。

所有站点由 Worker 直接访问各自官网，不依赖本机服务。B站对 Cloudflare 出口的 412 会如实标记，不使用第三方搜索数据替代。

## 配置、运行与部署

需要 Node.js 24：

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
npm run check
npm test
npm run test:runtime
npm run docs
```

| 变量 / Secret | 默认 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无，Secret | AI 分类与候选识别；生产在 Cloudflare Secrets 配置。 |
| `DEEPSEEK_MODEL` | deepseek-flash | DeepSeek 模型名称。 |
| `AI_TIMEOUT_MS` | 18000 | 每次 AI 请求超时，3000—25000 毫秒。 |
| `API_KEY` | 无，Secret | 可选 API 访问认证。 |
| `CACHE_TTL_SECONDS` | 300 | 摘要与完整目录缓存，30—3600 秒。 |
| `UPSTREAM_TIMEOUT_MS` | 生产 10000 | 每次官网请求超时。 |
| `CORS_ORIGIN` | * | 跨域来源。 |

配置 API_KEY 后，使用 Authorization: Bearer 或 X-API-Key 请求头；不接受 URL 密钥。页面、OpenAPI、能力清单、健康检查公开。在线调试仅请求当前域名，复制的 cURL 使用密钥占位符。

Worker 已连接 GitHub main 的 Cloudflare Workers Builds。推送后自动检查、测试、部署到现有 Worker，保留 `videosearch.webber.qzz.io` 与 Secrets。详见 [持续部署说明](docs/continuous-deployment.md)。

真实验收：`API_BASE_URL=https://videosearch.webber.qzz.io npm run smoke:official` 或 `npm run smoke`；任一站失败时非零退出，记录实际限制。受控代理环境可加 `NODE_USE_ENV_PROXY=1`。历史记录见 [validation.md](docs/validation.md)，旧版行为不代表当前版本。

MIT License.
