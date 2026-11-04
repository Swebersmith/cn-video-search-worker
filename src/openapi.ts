import { PLATFORMS } from './types';
import { CAPABILITIES, VERSION, DEFAULT_VIEW } from './aggregate';
const sourceId = { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,39}$', description: 'KV 配置中的来源 ID；通过 /v1/resources 获取已启用清单。' };
const adminSecurity = [{ resourceAdminKey: [] }];
const platform = { type: 'string', enum: Object.keys(PLATFORMS) };
const nullableInt = { type: ['integer', 'null'] };
const numbers = { type: 'array', items: { type: 'integer' } };
const strings = { type: 'array', items: { type: 'string' } };
const security = [{ bearerAuth: [] }, { apiKey: [] }, {}];
const aiParameter = { name: 'ai', in: 'query', schema: {type:'string',enum:['on','off'],default:'off'},
  description: '仅影视目录搜索及详情。off 完全不调用 AI；on 使用配置的 DeepSeek 辅助分类/复核，异常时退回规则。detail_url 保留此选择。' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string, description: string) => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const searchParameters = [
  // Keep q first: resource query parameters share that contract.
  {
    name: 'q',
    in: 'query',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 80 },
    example: '嫁金钗',
  },
  {
    name: 'view',
    in: 'query',
    schema: { type: 'string', enum: ['series'], default: DEFAULT_VIEW },
    description: '默认 series 返回长影视作品摘要；请求所选目录结果的 detail_url 可读取完整分集。第三方搜索使用 /v1/resources/search，不支持 view=resources。',
  },
  {
    name: 'platforms',
    in: 'query',
    schema: { type: 'string', default: 'all' },
    description: '仅官网总接口 /v1/search：all 或逗号分隔平台标识，如 tencent,youku；单站和资源站不支持。',
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    description: '每站作品数，不限制详情目录。',
  },
  aiParameter,
];
const searchContract = {
  summary: '聚合五站影视目录搜索',
  security,
  parameters: searchParameters,
  responses: {
    '200': response('SearchResponse', '本页结果，检查 partial 和 providers 状态'),
    '400': response('Error', '参数无效'),
    '401': response('Error', '认证失败'),
    '503': response('SearchResponse', '本次所选上游均不可用'),
  },
};
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: '五站官网搜索与 AI 影视目录',
    version: VERSION,
    description:
      '平台接口仅保留 series 影视目录；独立 /v1/resources 搜索第三方官采资源站。DeepSeek 仅分类和识别官方候选，不生成链接。',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      resourceAdminKey: { type: 'apiKey', in: 'header', name: 'X-Admin-Key', description: '独立 RESOURCE_ADMIN_KEY，不接受查询参数。' },
    },
    schemas: {
      ResourceSourceConfig: {
        type: 'object', required: ['id', 'name', 'endpoint', 'enabled'], properties: {
          id: sourceId, name: { type: 'string', minLength: 1, maxLength: 60 },
          endpoint: { type: 'string', format: 'uri', description: '公共 HTTPS MacCMS provide/vod JSON / XML 接口，不允许凭据、IP、额外端口或任意路径。' },
          enabled: { type: 'boolean' },
        },
      },
      ResourceConfig: {
        type: 'object', properties: {
          ok: { type: 'boolean' }, version: { const: 1 }, revision: { type: 'string' }, updated_at: { type: 'string' },
          storage: { enum: ['kv', 'defaults'] }, sources: { type: 'array', maxItems: 20, items: ref('ResourceSourceConfig') },
        },
      },
      ResourceEpisode: { type: 'object', properties: {
          overview: { type: 'string', description: 'TMDB 分集简介，仅安全对齐的正片补充。' },
          still_url: { type: ['string', 'null'] }, tmdb_episode_name: { type: 'string' }, tmdb_episode_id: { type: 'integer' },
        title: { type: 'string' }, url: { type: 'string' }, episode_number: nullableInt,
        episode_type: { enum: ['main', 'preview'] }, platform: { type: ['string', 'null'] },
        link_type: { enum: ['official_page', 'media', 'external_page'] }, playback_verified: { const: false },
      } },
      ResourceItem: { type: 'object', properties: {
          poster_url: { type: ['string', 'null'], description: 'TMDB 封面地址；匹配成功时补充。' },
          overview: { type: 'string', description: 'TMDB 剧情简介，zh-CN；缺失时为空字符串。' },
          tmdb: ref('TmdbMetadata'),
        id: { type: 'string' }, title: { type: 'string' }, source_id: sourceId,
        source_name: { type: 'string' }, source: { const: 'third_party' }, content_type: { const: 'resource' },
        year: { type: 'string' }, type_name: { type: 'string' }, remarks: { type: 'string' }, updated_at: { type: 'string' },
        detail_url: { type: 'string' }, play_sources: strings,
        lines: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, platform: { type: ['string', 'null'] },
          episodes: { type: 'array', items: ref('ResourceEpisode') }, previews: { type: 'array', items: ref('ResourceEpisode') },
        } } },
      } },
      ResourceSearch: { type: 'object', properties: {
        ok: { type: 'boolean' }, view: { const: 'resources' }, query: { type: 'string' }, page: { type: 'integer' },
        total: { type: 'integer', description: '本次第三方条目数，不是分集数量或所有上游总量。' }, partial: { type: 'boolean' }, source_policy: { const: 'third_party_resource_sites' },
        results: { type: 'array', items: ref('ResourceItem') }, providers: { type: 'array', items: { type: 'object', properties: {
          source_id: sourceId, source_name: { type: 'string' }, source: { const: 'third_party' },
          source_url: { type: 'string' }, status: { enum: ['ok', 'empty', 'unavailable'] }, count: { type: 'integer' },
          total: nullableInt, page: { type: 'integer' }, pagecount: nullableInt, has_more: { type: ['boolean', 'null'] }, warnings: strings,
        } } },
      } },
      TmdbMetadata: { type: 'object', properties: {
        source: { const: 'tmdb' }, status: { enum: ['matched', 'not_found', 'ambiguous', 'unavailable', 'skipped'] },
        id: { type: 'integer' }, media_type: { enum: ['tv', 'movie'] }, url: { type: 'string', format: 'uri' },
        season_number: { type: 'integer' }, episode_status: { enum: ['matched', 'skipped', 'unavailable'] },
      } },
      AI: {
        type: 'object',
        properties: {
          status: { enum: ['applied', 'fallback', 'disabled', 'not_needed'] },
          model: { type: 'string' },
          classified: { type: 'integer' },
          recovered: { type: 'integer' },
          warnings: strings,
        },
      },
      Series: {
        type: 'object',
        required: ['platform', 'id', 'title', 'detail_url', 'content_type'],
        properties: {
          poster_url: { type: ['string', 'null'], description: 'TMDB 封面地址；匹配成功时补充。' },
          overview: { type: 'string', description: 'TMDB 剧情简介，zh-CN；缺失时为空字符串。' },
          tmdb: ref('TmdbMetadata'),
          platform,
          platform_name: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          year: { type: 'string' },
          kind: { enum: ['movie', 'series', 'collection'] },
          category: { enum: ['movie', 'tv', 'variety', 'anime', 'documentary'] },
          type_name: { type: 'string' },
          total_episodes: nullableInt,
          url: { type: 'string' },
          detail_url: { type: 'string', description: '直接跟随该相对地址；保留关键词提示。' },
          score: { type: 'number' },
          content_type: { const: 'series' },
        },
      },
      Episode: {
        type: 'object',
        properties: {
          overview: { type: 'string', description: 'TMDB 分集简介，仅安全对齐的正片补充。' },
          still_url: { type: ['string', 'null'] }, tmdb_episode_name: { type: 'string' }, tmdb_episode_id: { type: 'integer' },
          platform,
          episode_number: nullableInt,
          title: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          episode_type: { enum: ['main', 'extra', 'preview'] },
          recognition: { enum: ['structured', 'ai'] },
          badges: { ...strings, description: '官网分集角标原文，例如 VIP、SVIP、预告、收官礼、超前点映；空数组表示没有文本角标。' },
        },
      },
      Catalogue: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          platform,
          series: ref('Series'),
          total: { type: 'integer' },
          main_total: { type: 'integer' },
          extra_total: { type: 'integer' },
          preview_total: { type: 'integer', description: '统一 episodes 列表中保留的预告数量，计入 total，不计入正片完整性。' },
          expected_total: nullableInt,
          update_notice: { type: 'string' },
          complete: {
            type: 'boolean',
            description: '正片目录与官方当前已发布范围一致；不代表全剧完结或无需会员。',
          },
          partial: { type: 'boolean' },
          missing_episode_numbers: { ...numbers, description: '已发布范围内未找到链接的编号。' },
          unavailable_episode_numbers: {
            ...numbers,
            description: '发现预告链接但正片尚未确认的编号；不计入正片，也不重复列为缺失链接。',
          },
          episodes: { type: 'array', items: ref('Episode'), description: '唯一分集列表，包含正片、附加内容和预告，按集数排序。同集已有正片时省略对应预告；无具体集号的预告保留。' },
          ai_mode: {type:'string',enum:['on','off']},
          ai: ref('AI'),
          warnings: strings,
          cached: { type: 'boolean' },
          fetched_at: { type: 'string', format: 'date-time' },
          source: { type: 'string' },
          took_ms: { type: 'integer' },
        },
      },
      SearchResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          view: { enum: ['series'] },
          ai_mode: {type:'string',enum:['on','off']},
          limit: { type: 'integer' },
          partial: { type: 'boolean' },
          total: { type: 'integer', description: '本次返回作品数量，不是某部剧总集数。' },
          took_ms: { type: 'integer' },
          results: { type: 'array', items: ref('Series') },
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                platform,
                status: { enum: ['ok', 'empty', 'degraded', 'unavailable'] },
                count: { type: 'integer' },
                total: nullableInt,
                truncated: { type: 'boolean' },
                warnings: strings,
                ai_mode: {type:'string',enum:['on','off']},
          ai: ref('AI'),
                cached: { type: 'boolean' },
                fetched_at: { type: 'string' },
              },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          ok: { const: false },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
  },
  paths: {
    '/v1/admin/resource-sources': {
      get: { summary: '管理员读取全部来源（含停用项）及 KV 配置版本', security: adminSecurity,
        responses: { '200': response('ResourceConfig', '配置快照'), '401': response('Error', '管理密钥无效'), '503': response('Error', '未配置管理密钥或 KV 不可用') } },
      put: { summary: '替换 KV 来源配置，最多 20 站；KV 最终一致，请避免并发编辑', security: adminSecurity,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['revision', 'sources'], properties: {
          revision: { type: 'string', description: '读取或上次保存响应中的 revision；可检测已读到的版本冲突，不提供强一致锁。' },
          sources: { type: 'array', maxItems: 20, items: ref('ResourceSourceConfig') },
        } } } } }, responses: { '200': response('ResourceConfig', '已保存快照，其他地区通常需 30–60 秒同步'),
          '400': response('Error', '配置无效'), '401': response('Error', '管理密钥无效'), '409': response('Error', '版本已变更，请重新读取'),
          '413': response('Error', '请求体超过 64 KiB'), '503': response('Error', '未绑定 KV 或存储不可用') } },
    },
    '/v1/admin/resource-sources/check': { post: {
      summary: '测试草稿来源的搜索、准确详情、随机无结果关键词和分页；不保存配置或访问播放链接', security: adminSecurity,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['source'], properties: {
        source: ref('ResourceSourceConfig'), q: { type: 'string', default: '三体', minLength: 1, maxLength: 80 },
      } } } } }, responses: { '200': { description: 'healthy、checks、各类链接计数和耗时；检查失败仍返回检查报告' },
        '400': response('Error', '草稿无效'), '401': response('Error', '管理密钥无效') },
    } },
    '/v1/resources': { get: { summary: 'KV 中已启用的第三方来源；登记不代表持续可用或官方授权', responses: { '200': { description: 'Configured resource sources' } } } },
    '/v1/resources/search': { get: {
      summary: '搜索已启用的第三方来源；results 为条目，detail_url 读取该条线路详情', security,
      parameters: [searchParameters[0], { name: 'sources', in: 'query', schema: { type: 'string', default: 'all' },
        description: 'all 为全部启用来源；或逗号分隔来源 ID，通过 /v1/resources 读取当前清单。' }, { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1 }, description: '官采来源的上游页码。' }],
      responses: { '200': response('ResourceSearch', '第三方条目与各源状态；不代表可以播放'),
        '400': response('Error', '无效参数'), '401': response('Error', '认证失败'), '503': response('ResourceSearch', '所选来源本次均不可用') },
    } },
    '/v1/resources/{source}/items/{id}': { get: {
      summary: '读取指定官采条目与分线路地址，不访问或解析播放链接', security,
      parameters: [{ name: 'source', in: 'path', required: true, schema: sourceId },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' } }],
      responses: { '200': { description: 'source_id、第三方 item（ResourceItem）与 warnings', content: { 'application/json': { schema: { type: 'object', properties: {
        ok: { type: 'boolean' }, source: { const: 'third_party' }, source_id: { type: 'string' }, item: ref('ResourceItem'), warnings: strings,
      } } } } }, '400': response('Error', '无效来源或 ID'), '401': response('Error', '认证失败'),
        '404': { description: '上游未返回指定 ID' }, '503': { description: '来源不可用' } },
    } },
    '/health': {
      get: {
        summary: '进程健康状态，不代表官网或 AI 可用性',
        responses: { '200': { description: 'Worker is running' } },
      },
    },
    '/v1/platforms': {
      get: { summary: '平台与目录入口', responses: { '200': { description: 'Platform capabilities' } } },
    },
    '/v1/search': { get: searchContract },
  },
};
for (const p of Object.values(CAPABILITIES)) {
  Object.assign(openapi.paths, {
    [p.endpoint]: {
      get: {
        ...searchContract,
        summary: `${p.name}单站查询`,
        parameters: searchParameters.filter((v) => v.name !== 'platforms'),
      },
    },
  });
  Object.assign(openapi.paths, {
    [p.detail_endpoint]: {
      get: {
        summary: `${p.name}指定作品目录与 AI 分集识别`,
        security,
        description:
          '使用搜索返回的 detail_url。默认 ai=off 仅规则，可选 ai=on；正片、预告和附加内容统一返回 episodes，同集已有正片则省略预告。AI 失败时退回规则。',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          aiParameter,
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string', maxLength: 80 },
            description: '保留 detail_url 的原关键词。',
          },
        ],
        responses: {
          '200': response('Catalogue', '目录，检查 complete、预告与 AI 状态'),
          '400': response('Error', '无效 ID 或参数'),
          '401': response('Error', '认证失败'),
          '503': response('Catalogue', '本次没有可用正片目录'),
        },
      },
    },
  });
}
