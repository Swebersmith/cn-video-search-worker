// Shared, static integration guide for the public documentation page.
export const USAGE_GUIDE_HTML = String.raw`
<section id="modes"><p class="eyebrow">CHOOSE YOUR MODE</p><h2>三种模式，怎样选择？</h2><p class="intro">基础地址：<code>https://videosearch.webber.qzz.io</code>。下方示例路径都相对于此地址，公开查询均使用 GET，返回 JSON。总接口默认查询五站；单站接口只返回指定平台的数据。</p>
<div class="table-wrap"><table><thead><tr><th>需要什么</th><th>使用模式</th><th>入口与结果</th></tr></thead><tbody>
<tr><td>查看官网原样搜索结果</td><td><a href="#guide-official">官网综合搜索</a></td><td><code>/v1/search?view=official</code>；返回本页卡片，可包含剧集、短视频和作者。</td></tr>
<tr><td>先选电影或剧集，再展开分集</td><td><a href="#guide-series">影视目录</a></td><td><code>/v1/search?view=series</code>；返回作品摘要，再请求所选作品的 <code>detail_url</code>。</td></tr>
<tr><td>查询管理页启用的采集站</td><td><a href="#guide-resources">官采资源站</a></td><td><code>/v1/resources/search</code>；返回第三方条目、播放线路与分集。</td></tr>
</tbody></table></div><p class="hint">页面下拉框中的 resources 是界面选项。第三方模式使用独立路径，不要向 /v1/search 传 view=resources。官网总接口只聚合官网结果；资源站接口只聚合已启用的第三方来源。</p></section>
<section id="guide-official"><p class="eyebrow">01 / OFFICIAL</p><h2>官网综合搜索：按页读取官网卡片</h2><p>适合展示网站原有搜索内容，保留卡片类型、顺序与原始数据，不使用 AI 筛选。省略 <code>view</code> 时默认使用此模式。搜索结果条数不是电视剧集数，一张作品卡片也不等于一集。</p>
<pre><code># 五站聚合，读取第 1 页
GET /v1/search?q=三体&amp;view=official&amp;page=1

# 只查询爱奇艺，第 2 页
GET /v1/iqiyi/search?q=三体&amp;view=official&amp;page=2

# 总接口只查询腾讯、优酷
GET /v1/search?q=三体&amp;view=official&amp;platforms=tencent,youku&amp;page=1</code></pre>
<p>读取 <code>results[]</code> 展示卡片；<code>results[].raw</code> 是该卡片原始内容，<code>providers[].upstream</code> 是本次官方响应。部分卡片没有可用链接，<code>url</code> 可为 null；作者、短视频等卡片不代表剧集播放页。</p><p>继续查询时将 <code>page</code> 加一，并检查各站的分页元数据和状态；不同平台的总量、分页能力可能不同。<code>limit</code> 在此模式不生效。需要完整分集目录时，改用下一种模式重新搜索作品。</p></section>
<section id="guide-series"><p class="eyebrow">02 / SERIES</p><h2>影视目录：搜索作品 → 选择版本 → 读取分集</h2><p>适合电影、长电视剧、综艺、动漫和纪录片目录。默认 ai=off，使用官网字段与规则分类；可选择 ai=on 启用 AI 辅助筛选与复核，排除短剧、陪看、解说、剪辑及普通短视频。AI 只能识别已有候选，不生成或猜测播放链接。</p>
<pre><code># 第一步：搜索作品摘要，每站最多 5 部
GET /v1/search?q=三体&amp;view=series&amp;limit=5

# 也可只查询腾讯
GET /v1/tencent/search?q=三体&amp;view=series&amp;limit=5

# 第二步：从 results[] 选择作品，直接请求该条的 detail_url
# 路径形式如下；{platform} 和 {id} 来自所选结果，不是固定示例值
GET /v1/{platform}/series/{id}?q=三体</code></pre>
<p>搜索响应的 <code>results[]</code> 是作品摘要，不是分集。通过 <code>platform</code>、<code>id</code>、<code>year</code>、<code>type_name</code> 区分同名版本，再请求该条 <code>detail_url</code>；不要自行选第一条或拼接其他站的 ID。<code>limit</code> 只限制每站摘要数，不截断详情中的分集。搜索与详情都支持 <code>ai=off</code> / <code>ai=on</code>，detail_url 保留该选择；AI 失败时使用规则返回结果。此模式不支持 <code>page</code>，携带会返回 400。</p>
<div class="response-grid"><article><h3>详情里怎样取链接？</h3><p><code>episodes[]</code>：唯一分集列表，包含正片、预告和附加内容，episode_type 为 main / preview / extra。同集已有正片时省略该集预告，无集号的周预告保留。</p><p>每条的 <code>url</code> 是官方播放页，<code>badges[]</code> 保留 VIP、SVIP、收官礼、抢先看、超前点映等官网角标，页面在分集右上角展示。<code>total</code> 等于 episodes.length。</p></article><article><h3>缺集和未更新怎样区分？</h3><p><code>missing_episode_numbers</code> 是当前已发布范围内没找到链接的编号；<code>unavailable_episode_numbers</code> 是只发现预告、正片尚未确认的编号。尚未发布的计划集数不自动算缺集。</p><p><code>complete</code> 核对当前目录是否取齐，不表示全剧完结或免费。结合 <code>update_notice</code>、<code>warnings</code>、<code>ai</code> 判断实际状态；AI 降级时仍会返回经过规则校验的结果。</p></article></div>
<p>接入示例（在你的服务端运行；如已配置 API_KEY，请放在请求头）：</p>
<pre><code>const base = 'https://videosearch.webber.qzz.io';
const headers = {}; // 需要认证时：{ Authorization: 'Bearer YOUR_API_KEY' }
const url = new URL('/v1/tencent/search', base);
url.search = new URLSearchParams({ q: '三体', view: 'series', limit: '5' });
const response = await fetch(url, { headers });
const search = await response.json();
if (!response.ok) throw new Error(JSON.stringify(search));
// 用 search.results 展示选项，让使用者按片名、年份选择作品。
async function loadSelectedSeries(selected) {
  const response = await fetch(new URL(selected.detail_url, base), { headers });
  const detail = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(detail));
  return detail; // 全部分集链接：detail.episodes（用 episode_type 区分正片、预告与附加内容）
}</code></pre></section>
<section id="guide-resources"><p class="eyebrow">03 / RESOURCES</p><h2>官采资源站：按来源搜索，再读取准确条目</h2><p>来源由 <a href="/admin">采集站管理页</a> 配置，存入 Cloudflare KV。先读取当前启用的来源，避免写死来源 ID。采集站是第三方索引，即使链接指向官方平台，也不等于官网原始搜索或官方授权。</p>
<pre><code># 第一步：获取当前启用来源，读取 sources[].id
GET /v1/resources

# 第二步：聚合全部已启用来源，第 1 页
GET /v1/resources/search?q=三体&amp;sources=all&amp;page=1

# 只查金蝉；也可用 sources=jinchan,tw 选择多个已启用来源
GET /v1/resources/search?q=三体&amp;sources=jinchan&amp;page=1

# 第三步：选择 results[] 中准确条目，请求其 detail_url
# {source}、{id} 均来自该条结果
GET /v1/resources/{source}/items/{id}</code></pre>
<p>搜索条目用 <code>source_id + id</code> 标识，不同采集站的 ID 不能混用。搜索结果如果已有 <code>lines[]</code> 可以直接展示；需要读取选中条目的详情时跟随 <code>detail_url</code>，详情条目在 <code>item</code> 字段中，而不是 results。</p><p>分集在 <code>item.lines[].episodes[]</code>，预告在 <code>item.lines[].previews[]</code>。每条线路单独保留；需要全部链接时遍历每条线路的 episodes 和 previews。资源站详情没有官网目录的 complete 缺集合同，不应从条目数推断全集已齐。</p>
<div class="table-wrap"><table><thead><tr><th>link_type</th><th>含义</th><th>接入方式</th></tr></thead><tbody><tr><td>official_page</td><td>官方平台播放页</td><td>可作为播放页链接跳转，会员和地区限制仍以平台为准。</td></tr><tr><td>media</td><td>M3U8 等媒体地址</td><td>第三方地址，文档页以文本展示；接口不请求媒体流。</td></tr><tr><td>external_page</td><td>第三方播放页或线路</td><td>文档页以文本展示；接口不调用第三方解析。</td></tr></tbody></table></div>
<p><code>playback_verified=false</code> 表示未验证能否播放。默认来源以 /v1/resources 的实时清单为准；停用或删除的来源不参与搜索，直接指定会返回 400。来源全部停用时返回空列表。管理写入用独立的 <code>X-Admin-Key</code>，公共搜索与详情使用可选的 API_KEY，不能互相替代；不要把管理密钥用于普通搜索。</p></section>`;
