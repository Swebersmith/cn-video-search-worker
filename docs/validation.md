# 验证记录

## 2026-10-29 · 1.4.1 哔哩哔哩官网页面数据

生产出口对旧 API 和匿名会话入口返回 412，但官网桌面搜索页仍提供 SSR 搜索结果。新增官网页面优先来源，安全解析 window.__pinia 的数据序列化形式，只允许字面量、对象、数组和形参数据引用；拒绝任意调用、成员访问、赋值或可执行函数体。页面数据校验原生页码，失败时仅尝试同站官方 API 并明确标记 degraded。

本机官网页面取得“三体”的 3 张番剧卡片和 42 张普通投稿，与该页面 SSR 数据一致；旧 API 默认页长仅 20，进一步说明不能把旧接口结果直接宣称为任意官网页面的完整结果。五站首轮实测仍均成功，B站来源为 search.bilibili.com/all 的原始页面数据。生产结果以发布后验收为准。

## 2026-10-29 · 1.4.0 同站官网综合搜索

默认视图改为 official，保留各平台本页原始卡片、原始顺序和完整官网 JSON。新增 page 原生分页；官网模式不执行旧影视摘要的频道过滤、模糊阈值、去重或 limit 截断。影视目录仍通过显式 view=series 使用。

运行时代码已移除 Brave 和芒果的腾讯索引兜底；兼容与目录搜索缓存均更换命名空间。芒果从当前官网公开脚本确认 /pc/search/v2 及公开校验参数，真实请求成功，不再使用失效的 v1 搜索。哔哩哔哩默认改为综合搜索，保留普通投稿及用户分类，遇 412 可按本站公开入口初始化匿名会话后重试一次，仍失败则如实报错。

本机真实上游测试五站均成功：腾讯 11 张、爱奇艺 20 张、优酷 20 张、芒果 10 张、哔哩哔哩 23 张卡片。真实第二页均发起本站请求并取得响应，爱奇艺、优酷和哔哩哔哩返回的原生页码为 2；腾讯和芒果第二页卡片也发生变化。腾讯按 areaBoxIndex 展开正式内容模块，避免只返回两个外层占位卡片。数量与排序是当次响应，不承诺与登录、个性化及地区不同的浏览器逐项一致。

以下为历史版本验证记录；其中第三方搜索和跨站兜底描述不再适用于当前运行时代码。

## 2026-10-29 · 1.3.2 空章节名与连载目录

用户反馈优酷《嫁金钗》搜索正常、展开却返回 HTTP 503 和 0 条。复现发现官方 `show_episode` 条目 `chapterName=null`，旧代码只接受“正片”，误删全部条目。现兼容空章节名，同时校验集序、作品及附加内容标记；明确的番外独立计数，无集序预告不会混入正片。

增加 `update_notice`，按上游“更新至 N/M 集”核对当前范围，保留计划总集数。真实上游《嫁金钗》说明为 22/30，但目录只返回 1—21 集和两条无集序预告；修复后展示 21 集、只提示缺 22，不再将 23—30 算作缺集。陪看版为当前完整 4/10 集；《甄嬛传》76 集、《藏海传》40 集均返回完整目录；《长安二十四计》的 28 集正片与 1 条番外分开计数。上述响应仅证明当次目录情况，不代表播放权限。

## 2026-10-29 · 优酷官方 JSON 备用入口修复

旧版 `so.youku.com` 网页在本次实测中返回验证页。新版官方页面 `https://search.youku.com/search_video?keyword=甄嬛传` 的公开脚本使用 `/api/search`，完整选集参数为 `appScene=show_episode`、`appCaller=h5`、`showIds` 和 `keyword`。已接入这些官方入口：网页失败时发现作品，预览不完整时再按准确 showId 加载正片。跨站作品、错 showId、缺集均不能标为完整。旧版扁平搜索也支持官方 JSON 播放链接备用源。

修复代码通过本机 Node.js 网络出口执行 `npm run smoke`，五站均返回搜索结果及 `complete=true` 的目录，退出码为 0：腾讯《三体》40 条（30 集正片、10 个彩蛋），爱奇艺《海市蜃楼》24 集，优酷《甄嬛传》76 集，芒果《歌手2025》70 条（含加更、不同版本），哔哩哔哩首个匹配作品 15 集。原始时间、作品 ID、状态和 warnings 见 [五站真实实测](five-provider-smoke-2026-10-29.json)。优酷、芒果与哔哩哔哩使用备用入口时仍保留 degraded 与原入口故障提示。

本记录验证的是上述探测作品和本机出口；生产 Cloudflare 出口需要部署后重新执行 `API_BASE_URL=https://videosearch.webber.qzz.io npm run smoke`。本机通过不能替代生产实测，也不保证上游未来持续可用。

源码首次验证日期：2026-10-28。Cloudflare 部署及线上验证日期：2026-10-29。

## 统一聚合、单站接口和说明页面（v1.2.0）

总接口 `/v1/search` 与五个 `/v1/{platform}/search` 共用平台查询实现，默认 `mode=all`，将普通搜索与已接入的分集目录合并、按 URL 去重。`search` 和 `episodes` 模式使用相同路径；旧 `/v1/episodes` 仅保留兼容。首页 `/` 和 `/docs` 提供说明、能力清单、参数表和在线调试。

源代码提交 `e9d3994533526a757008d7ba64a8aef9e8853f81` 的类型检查、40 项离线回归测试、1 项真实 workerd 运行时测试及打包均通过，[GitHub CI](https://github.com/Swebersmith/cn-video-search-worker/actions/runs/40816866915) 已通过。测试验证了：

- 默认总查询含完整 24 集，搜索结果和分集的重复 URL 被合并。
- 每个单站接口只产生该站结果，总接口子集与单站接口的结果结构一致。
- 单次综合查询共享爱奇艺搜索数据，未重复请求搜索上游；缓存命中时避免额外调用。
- 不支持的目录功能返回 `unsupported`；单站失败不抹掉其他功能结果。
- 文档页面提交参数后请求正确单站 URL、正确渲染响应；上游标题按纯文本显示，非法链接不会变成可点击链接，复制命令不包含实际密钥。

线上通过 `https://videosearch.webber.qzz.io` 验证：

- 首页、JS、CSS、健康检查、OpenAPI 和五站能力清单均 HTTP 200。
- 默认聚合查询《海市蜃楼》返回 25 条：爱奇艺完整 24 集和腾讯 1 条，`partial=true` 提示其他站不可用。
- 爱奇艺单站默认查询返回 24 条，编号 1—24，目录完整；腾讯单站返回 1 条。所有单站响应均只包含各自平台。
- 优酷、芒果 TV、哔哩哔哩单站在本次实测中返回明确的上游故障状态，未假报成功。
- 腾讯的仅目录模式返回 HTTP 422、`unsupported`，无虚构目录。

原始结果见 [unified-api-2026-10-29.json](unified-api-2026-10-29.json)。浏览器自动化工具在本次环境不可用；页面验证使用 DOM 交互测试、真实 Worker HTTP 响应及资源检查，未进行真实浏览器的视觉验收。

## 爱奇艺完整分集目录验证（v1.1.0）

用户反馈《海市蜃楼》为 24 集，但搜索只显示 6 条。复现确认，旧搜索默认每站 `limit=5`，截图的 6 条由爱奇艺 5 条和腾讯 1 条组成，且搜索按相关度排序。爱奇艺上游搜索自身提供了 24 集，原接口输出被截断，不是该剧缺集。

新增 `/v1/episodes?q=海市蜃楼`，先选择电视剧专辑，再读取官方正片目录；同名电影、预告、花絮不会合入。线上以 `https://videosearch.webber.qzz.io` 调用，实际结果为：

- HTTP 200，电视剧专辑 `6244560312265801`，年份为 2025。
- `total=24`、`expected_total=24`、`complete=true`。
- 分集编号恰为 1—24，`missing_episode_numbers=[]`，`warnings=[]`。
- 第 1 集：`https://www.iqiyi.com/v_27puk4z5uko.html`。
- 第 24 集：`https://www.iqiyi.com/v_wrzrjad2qo.html`。

原始线上响应见 [iqiyi-episodes-2026-10-29.json](iqiyi-episodes-2026-10-29.json)。这证明目录完整，不代表会员或地区限制被解除。

普通搜索保留默认 `limit=5`，新增 `available_count` 和 `truncated`。同一关键词的线上爱奇艺搜索观察到 41 条候选、实际输出 5 条、`truncated=true`；候选还含相关片段，不应当作总集数。

本次类型检查、30 项离线回归测试、1 项 workerd 运行时测试及 Worker 打包均通过；代码提交 `4af9876e252f0e106c555ee1cda7bc683efbf2cd` 的 [GitHub CI](https://github.com/Swebersmith/cn-video-search-worker/actions/runs/40810898901) 已通过。新测试涵盖数字排序、同名电影排除、分页、缺集、重复/冲突链接、访问认证、故障降级、缓存和最多 500 集的请求上限。

## 自定义域名验证（2026-10-29）

`videosearch.webber.qzz.io` 已通过 Cloudflare Workers Custom Domain 绑定至 `cn-video-search`，Cloudflare 自动管理 DNS 与 HTTPS 证书。现以 `https://videosearch.webber.qzz.io` 为正式接入地址，原 `workers.dev` 地址保留。

已通过有效 HTTPS 连接验证 `/health`、`/openapi.json` 返回 HTTP 200；查询 `q=三体&platforms=tencent,iqiyi&limit=1` 返回 HTTP 200 和播放页结果。域名配置已同步至 `wrangler.jsonc`，后续使用 Wrangler 部署时会保留绑定。该验证不代表所有上游平台均可用，五站状态仍以接口响应为准。

## Cloudflare 线上验证（2026-10-29）

首版部署地址：`https://cn-video-search.382990094xwb.workers.dev`，当时业务源码提交为 `2c80783d28b48528cc7614ec5f6565556ada7724`；最新部署标识见 [deployment.json](deployment.json)。当前没有配置 `API_KEY` 和 `BRAVE_SEARCH_API_KEY`。

- `/health` 返回 HTTP 200，`ok=true`。
- `/openapi.json` 返回 HTTP 200，OpenAPI 版本为 3.1.0。
- `/v1/platforms` 返回 HTTP 200。
- 查询 `q=三体&platforms=tencent,iqiyi&limit=1` 返回 HTTP 200、两条播放页结果，`partial=false`；重复查询观察到缓存命中。

使用 `API_BASE_URL=https://cn-video-search.382990094xwb.workers.dev NODE_USE_ENV_PROXY=1 npm run smoke` 在真实部署接口执行五站实测。原始记录见 [cloudflare-smoke-2026-10-29.json](cloudflare-smoke-2026-10-29.json)。

| 平台 | 线上实测状态 | 说明 |
| --- | --- | --- |
| 腾讯视频 | 返回结果 | `status=ok` |
| 爱奇艺 | 返回结果 | `status=ok` |
| 优酷 | 不可用 | `SCHEMA_OR_CHALLENGE`，疑似验证页 |
| 芒果 TV | 不可用 | 上游 HTTP 401 |
| 哔哩哔哩 | 不可用 | 上游 HTTP 412 |

因此线上五站实测仍以非零退出码结束。部署和接口本身已验证可用，**五站全部可用尚未实现**；未配置备用源，不能声称备用源已线上验证。

Python `urllib` 默认 User-Agent 访问该 `workers.dev` 域名时观察到 Cloudflare 1010；Node 客户端正常返回。可按照 [官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/) 设置识别应用的描述性 User-Agent。

## 首版代码验证

- `npm run check`：TypeScript 检查。
- `npm test`：19 项回归测试，包括参数校验、五站适配、URL 白名单、模糊排序、认证、超时、故障隔离、备用源过滤和缓存回退。
- `npm run test:runtime`：先打包，再在真实 workerd / Miniflare 运行时中使用模拟上游验证 fetch、响应流、认证及 Cloudflare Cache API。
- `npm run build`：Wrangler dry-run，验证 Worker 能打包，不会发布。

最终执行结果以仓库 CI 为准。真实站点的可用性独立于离线测试结果。

## 部署前真实上游实测（2026-10-28）

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

## 部署前本地 Worker 运行环境

本地 `wrangler dev` 的健康检查、平台列表、OpenAPI 和非法参数返回已验证。真实外部调用在该本地运行时出现 `NETWORK_ERROR` / `TIMEOUT`，与通过受控代理运行的 Node 结果不同；不能据此声称 Cloudflare 出口已验证可用。

额外使用 workerd / Miniflare 和受控模拟上游测试 Worker 的请求、流读取、认证与真实 Cache API，避免仅依赖 Node 单测。后续真实 Cloudflare 出口结果已记录在本文顶部；本地限制不再作为线上可用性的依据。

## 2026-10-29 · 1.3.0 两层剧集与目录

- 默认搜索返回多个作品摘要，五站各自按 ID 展开目录。旧 mode / view=videos 保留历史契约。
- 本地 47 项回归测试和 1 项真实 workerd 测试通过：五站多版本选择、目录隔离、预告过滤、附加内容、缺集 / 失败分页、认证、缓存以及页面展开交互。
- 将公开响应裁剪后保存为 Youku / Bilibili 固定样本，验证优酷《甄嬛传》76 集不与精讲版混合，哔哩哔哩《我的三体 第四季》过滤预告后 9 集。
- 环境中真实请求：爱奇艺《海市蜃楼》24 集 complete=true；腾讯《三体》30 集主目录 + 10 个彩蛋 complete=true；芒果《歌手2025》读取 3 页 70 条（含不同版本及加更）complete=true；哔哩哔哩对应 season 目录 9 集 complete=true。
- 优酷搜索曾取得完整 SSR 数据，后续请求出现验证页面；哔哩哔哩分类搜索间歇出现 412；芒果原生搜索 401 时使用腾讯公开索引中的芒果官方链接发现作品。实际失败均如实标记，不以固定样本或硬编码目录替代线上查询。
- 页面使用 linkedom 交互测试，覆盖选择版本后加载目录、收起目录、认证头与外域目录链接拒绝；本环境没有浏览器工具，未进行截图级检查。

### 1.3.1 · 哔哩哔哩公开备用入口

- 增加官方 `search/all/v2` 发现备用源和 `season/section` 主目录备用源。冷缓存使用官方播放页的 `__NEXT_DATA__` JSON 校验 season_id 与正片分区 ID；只读取 JSON，不执行页面脚本。
- 本地检查、49 项回归测试及 1 项 workerd 测试通过；加入公开搜索、主分区和页面元数据的裁剪样本，验证分类接口 / season 接口 412 后仍能正确选择 9 集目录，拒绝错季响应。
- 先前提交 d58149c 已由 Cloudflare 原生构建 43b93068-09a6-43bb-b765-832ceb899af5 自动部署成功；域名实测默认返回 series 摘要，五个 detail 路径及页面资产均已上线。该次真实五站检测中腾讯、爱奇艺、芒果目录完成，优酷验证页、哔哩哔哩 412 如实报错，因此全站 smoke 未通过；本补丁增加公开备用入口，不将本地测试当成五站线上成功证据。
