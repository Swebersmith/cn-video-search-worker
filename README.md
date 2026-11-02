# VideoSearch · 五站官网搜索与 AI 影视目录

正式地址：<https://videosearch.webber.qzz.io/> · [OpenAPI](https://videosearch.webber.qzz.io/openapi.json)

**只保留两个模式：官网综合搜索、影视目录。** 总接口聚合五站，单站接口只查询对应官网。

| 模式 | 请求示例 | 行为 |
| --- | --- | --- |
| 官网综合搜索 | `/v1/search?q=嫁金钗&view=official&page=1` | 默认模式，保留官网本页全部卡片和顺序，以及原始响应。 |
| 影视目录 | `/v1/search?q=嫁金钗&view=series&limit=5` | 筛选电影、长电视剧、综艺、动漫、纪录片；DeepSeek 辅助分类，排除短剧、陪看、解说、花絮、路透和普通短视频。 |

单站路径为 `/v1/{platform}/search`，平台标识：`tencent`、`iqiyi`、`youku`、`mango`、`bilibili`。例如：

```text
GET /v1/youku/search?q=嫁金钗&view=series
→ 选择 results[] 中的作品，直接跟随 detail_url
GET /v1/youku/series/bcaa87c7834c46f99e7b?q=嫁金钗
→ 该作品的正片目录、预告和完整性状态
```

2.0 删除了旧版扁平链接模式、三个兼容选项和旧爱奇艺专辑选择接口；旧参数请求返回 400，已移除的路由返回 404。新接入只使用上面两种模式和 `detail_url`。

## 参数与返回

| 参数 | 范围 | 用途 |
| --- | --- | --- |
| `q` | 1—80 字符，搜索必填 | 模糊片名；目录请求保留 detail_url 中的关键词提示。 |
| `view` | `official` / `series` | 默认 official。 |
| `page` | 1—1000，默认 1 | 仅 official，每次读取官网一页。 |
| `limit` | 1—20，默认 5 | 仅 series，限制每站作品数，不截断展开的目录。official 忽略此参数。 |
| `platforms` | all 或逗号分隔平台标识 | 仅聚合接口，用于选择平台子集。 |

官网模式每次读取本页真实官网响应，不进行 AI 改写、相关度重排、去重或目录类型过滤。`results[].raw` 保留完整卡片，`providers[].upstream` 保留官方原始响应。官网自己收录的外站卡片仍保留为原始数据；本服务不会调用别站搜索代替该站。

目录模式的摘要包含 `id`、`title`、`year`、`category`、`type_name`、`total_episodes`、`detail_url`。分类只允许 `movie`、`tv`、`variety`、`anime`、`documentary`；作品长短依据内容类型，不凭集数多就把短剧当成长电视剧。芒果只将官网 program 等作品卡片作为候选，不把标了“电视剧”的几十秒路透视频当成正剧。

目录详情包含：

- `episodes[]`：正片及附加内容，带 `episode_number`、`title`、官方 `url`、`episode_type`（main / extra）。
- `previews[]`：预告链接，`episode_type=preview`，不计入正片或目录总条数。
- `total` / `main_total` / `extra_total`：实际目录条数。综艺保留上下、加更等原始标题，不将排序号伪装成期数。
- `expected_total`：官方当前发布范围对应的目录条数；计划全集数仍在 `series.total_episodes`。
- `missing_episode_numbers`：当前已发布范围内没有找到链接的编号。
- `unavailable_episode_numbers`：已找到预告，但正片尚未确认的编号；与缺失链接分开显示。
- `update_notice`：官方更新说明。`complete` / `partial` / `warnings` 表明本次目录是否取齐、是否存在上游限制。
- `ai`：AI 状态、模型、分类数、实际补充条数和错误代码。

例如本次《嫁金钗》官方更新说明写 22/30 集，但目录只提供 1—21 集正片，第 22、23 个候选明确标“预告”。服务会提供预告链接，并将第 22 集标为“正片待确认”；不会用预告替代正片，也不会把尚未发布的 23—30 集列为缺失。

`complete=true` 要求来源、分页、当前条数和编号校验通过，不表示全剧完结、免会员或每页必然可播放。

## DeepSeek 辅助处理

默认模型为 `deepseek-flash`，服务端调用 DeepSeek 的 JSON 输出接口，关闭思考模式以降低交互等待。目录查询中的作品标题、官方类型和精简候选标签会发送给 DeepSeek；访问密钥不进入模型提示、前端、URL、日志或 GitHub。

分类结合官方类型与 AI 判断。官方明确为短剧、陪看、剪辑等内容时，模型不能将其提升为长影视作品。AI 不可用时使用有明确依据的类型规则；无法确认的类型不进入目录，并在 `ai.status=fallback` 和 warnings 中说明。

从官方响应提取候选并校验作品归属和官方播放路径，保留原始标题、章节、角标、时长及预告标记（包括腾讯字符串形式的 `is_trailer`）。明确预告直接进入 `previews`；VIP / 抢先看角标不会直接被当成预告。

AI 除了补充未解析候选，还会复核已经解析的同集多链接和电影、电视剧中的异常短时长条目，结合同集候选与已有目录判断正片、预告、附加内容或无关内容。**模型只返回候选编号，不输出 URL。** 程序检查置信度、集序、已播范围及冲突后重新计算完整性；官方明确标为预告的内容不能被 AI 改成正片。AI 不可用或无法消除的正片编号冲突会暂不收录并返回 `CONFLICTING_EPISODE_NUMBERS`，不随意选取某条链接；综艺分段保留。复核不完整返回 `AI_EPISODE_AUDIT_PARTIAL`。

《走马上任》的腾讯官方样本包含 5 条正片与 6 条预告：修复后正片只列第 1—5 集，6 条预告单独返回，第 6、7 集标为正片待确认。腾讯搜索总数包含预告占位；仅在官方返回条目能完整解释该总数时，按实际正片、附加条目及仅有预告的编号校正 `expected_total`。

作品摘要和分类默认缓存 5 分钟；完整目录单独缓存。AI 请求有超时、响应大小和候选数量上限。使用已有 `API_KEY` 认证可控制共享接口访问；AI 调用使用你自己的 DeepSeek 配额。

## 官网来源

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
