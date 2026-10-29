# VideoSearch · 五站官网搜索与影视目录

默认搜索直接读取各平台官网综合搜索的本页响应。**每个站点只查询自己的官网，不使用第三方聚合接口、搜索引擎或其他平台的索引补结果。**

正式地址：https://videosearch.webber.qzz.io/

## 1.4.0 行为变化

默认 view 从 series 改为 official。旧版仅提取可展开目录的电视剧/番剧，省略了电影、普通视频、创作者及其他卡片，且会按本地相关度重排；这不能等同于官网搜索。

新版官网模式保留官方响应的卡片和顺序，不按模糊匹配分数过滤，不去重，不用 limit=5 截断。未知模板同样保留。官网自己索引到的外站内容也保留为官网原始卡片，这与调用外站搜索代替本站结果不同。

已彻底移除 Brave 备用搜索和“用腾讯索引替代芒果搜索”的运行时代码。旧搜索缓存更换命名空间，避免读回旧版跨来源结果。所有搜索入口，包括兼容模式，均受同站官网来源约束。

## 官网综合搜索（默认）

GET /v1/search?q=三体&page=1
GET /v1/tencent/search?q=三体&page=1
GET /v1/iqiyi/search?q=三体&page=1
GET /v1/youku/search?q=嫁金钗&page=1
GET /v1/mango/search?q=歌手2025&page=1
GET /v1/bilibili/search?q=三体&page=1

上述接口默认 view=official。聚合接口可用 platforms=tencent,iqiyi 选择子集；单站接口不接受 platforms。

- q：1—80 字符。
- page：1—1000，一次获取官网一页。页长由各站原生接口决定，继续修改 page 请求下一页。
- limit：官网模式忽略此参数，不截断官方本页结果；它只用于其他视图。
- results[]：本页卡片，包含 platform、rank、title、url、type_name、raw。rank 是平台内原顺序，raw 保留完整原始卡片，包括子视频和模块信息。
- providers[].upstream：该平台未经内容筛选的完整官网 JSON 响应，含原生分页、纠错词、相关搜索和其他模块，便于核对。
- providers[].source_url：实际官方接口；source=official。source_policy=same_platform_official_only 表示来源策略。
- providers[].total：官网标注总量，未知时为 null；顶层 total 是本页实际输出卡片数，两者不是一回事。
- providers[].has_more：官方明确给出的下一页信息，无法可靠判定时为 null，不凭卡片数量猜测末页。

卡片可以是影片、短视频、UP 主、人物或未知模板；没有可识别网页链接的卡片仍保留，url=null。网页模式可展开查看原始卡片，总 JSON 中还可查看完整官方响应。卡片中的非网页 App 跳转不执行，链接仅允许已知官方域名。

官网模式每次发起真实查询，不使用历史缓存来伪装当前官网结果。

## 五站官方来源

- 腾讯：腾讯官网使用的 MultiTerminalSearch。根据 normalList 中的 areaBoxIndex 展开官方模块，保留电影、电视剧、其他卡片和相关搜索的顺序。
- 爱奇艺：官网 mesh homePageV3 综合搜索，保留所有 templates，不仅提取电视剧频道。
- 优酷：官网 search.youku.com/api/search，保留 pageComponentList、originNodes 及官方分页。
- 芒果：从当前官网公开脚本确认的 mobileso.bz.mgtv.com/pc/search/v2，按官网请求参数和公开校验规则生成请求。旧版 v1 的 401 不再通过腾讯索引兜底。
- 哔哩哔哩：官网 search/all/v2 综合搜索，保留番剧、影视、普通投稿、用户和其他返回分类，不仅查番剧/影视。

这里对齐的是官网未登录、默认综合搜索的数据响应。登录状态、地区、个性化、官网 AB 实验、时间以及网络出口可能改变结果；本服务不会声称与任意用户浏览器的个性化页面逐项相同。HTTP 401/412、风控、超时或接口改版会明确返回 unavailable 和官网搜索链接，不用别站或第三方结果冒充成功。

## 影视目录（可选筛选视图）

如需原来的“选作品 → 展开分集”，显式使用 view=series：

GET /v1/youku/search?q=嫁金钗&view=series&limit=5
→ 跟随 results[].detail_url

此视图只包含当前适配器能识别并展开目录的影视摘要，是筛选视图，不是官网全部结果。limit 为每站 1—20 部作品，默认 5，不截断展开后的目录。

目录含 total、main_total、extra_total、expected_total、complete、missing_episode_numbers、warnings。complete=true 表示当前来源目录取齐，不表示全剧完结或无会员限制。

优酷兼容 chapterName=null 的正片，用有效集序和作品 ID 校验；明确番外单列为 extra。update_notice 保留官方连载说明，series.total_episodes 保留计划总集数，未播集数不列为缺失。例如《嫁金钗》官方写更新至22/30集但本次只返回1—21集时，展示21集并只提示缺22，不伪造剩余链接。

显式 view=videos 或旧 mode=all/search/episodes 仍保留历史扁平链接格式；旧 /v1/episodes 仅兼容爱奇艺目录。兼容模式的筛选、相关度排序与缓存不等同于官网模式。

## 运行、测试与生产部署

需要 Node.js 24：

~~~bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
npm run check
npm test
npm run test:runtime
npm run docs
npm run smoke:official  # 官网综合搜索真实实测
npm run smoke           # 筛选目录模式真实实测
~~~

生产验收设置 API_BASE_URL=https://videosearch.webber.qzz.io，再运行 smoke:official。受控代理环境可设置 NODE_USE_ENV_PROXY=1。原始结果分别写入 official-smoke-results.json 与 smoke-results.json，任一站失败均非零退出，不将离线样本测试当成生产五站可用证据。

API_KEY 为可选访问密钥，配置后使用 Authorization: Bearer <key> 或 X-API-Key。密钥不接受 URL 参数，说明页、OpenAPI、能力清单和健康检查公开。不再需要任何第三方搜索密钥。

运行变量包括 API_KEY、CORS_ORIGIN、UPSTREAM_TIMEOUT_MS，以及兼容/目录视图使用的 CACHE_TTL_SECONDS、STALE_TTL_SECONDS。官网综合模式不使用搜索缓存。

生产 Worker 已连接 GitHub main 的 Cloudflare Workers Builds。合并后自动执行类型检查、回归测试和真实 workerd 测试，通过后部署到 cn-video-search，保留现有域名与运行变量。CI 通过不等于生产验收，仍需检查构建结果并从正式域名实测。

详细部署配置见 docs/continuous-deployment.md；历史验证记录见 docs/validation.md（旧版第三方/跨站兜底记录不代表当前版本行为）。

MIT License.
