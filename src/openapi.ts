import { PLATFORMS } from './types';

const videoSchema = {
  type: 'object', required: ['platform', 'platform_name', 'title', 'url', 'kind', 'score', 'source'],
  properties: {
    platform: { type: 'string', enum: Object.keys(PLATFORMS) }, platform_name: { type: 'string' },
    title: { type: 'string' }, url: { type: 'string', format: 'uri', description: '官方网页播放地址，未经逐次可播放性验证。' },
    kind: { type: 'string', enum: ['video', 'series'] }, score: { type: 'number', minimum: 0, maximum: 1 },
    source: { type: 'string', enum: ['native', 'brave'] },
  },
};
export const openapi = {
  openapi: '3.1.0',
  info: { title: '国内五大影视平台播放页搜索 API', version: '1.1.0', description: '腾讯视频、爱奇艺、优酷、芒果 TV、哔哩哔哩。仅返回官方网页地址；无流媒体解析、无会员绕过。' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    schemas: {
      Video: videoSchema,
      Error: { type: 'object', properties: { ok: { const: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
      SearchResponse: {
        type: 'object', properties: {
          ok: { type: 'boolean' }, query: { type: 'string' }, partial: { type: 'boolean' }, total: { type: 'integer', description: '本次实际返回的搜索结果条数，不是电视剧总集数。' }, limit: { type: 'integer' },
          took_ms: { type: 'integer' }, results: { type: 'array', items: { $ref: '#/components/schemas/Video' } },
          providers: { type: 'array', items: { type: 'object', properties: {
            platform: { type: 'string' }, status: { enum: ['ok', 'empty', 'degraded', 'unavailable', 'stale'] },
            count: { type: 'integer' }, available_count: { type: 'integer', description: '本次上游搜索中符合过滤规则的候选数，不是全剧总集数。' }, truncated: { type: 'boolean', description: '是否被本次 limit 截断。' }, warnings: { type: 'array', items: { type: 'string' } },
            cached: { type: 'boolean' }, fetched_at: { type: 'string', format: 'date-time' }, search_url: { type: 'string', format: 'uri' },
          } } },
        },
      },
    },
  },
  paths: {
    '/health': { get: { summary: '进程健康状态，不代表上游可用性', responses: { '200': { description: 'Worker is running' } } } },
    '/v1/platforms': { get: { summary: '平台列表与标识', responses: { '200': { description: 'Supported platforms' } } } },
    '/v1/episodes': { get: {
      summary: '获取爱奇艺电视剧的有序分集目录',
      description: '先选择电视剧专辑，再读取官方目录。complete=true 表示目录集数与完整编号一致；不代表无需会员或每个页面均可播放。最多读取 500 集，不受 search 的 limit=5 限制。',
      security: [{ bearerAuth: [] }, { apiKey: [] }, {}],
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 80 }, example: '海市蜃楼' },
        { name: 'platform', in: 'query', schema: { type: 'string', enum: ['iqiyi'], default: 'iqiyi' } },
        { name: 'album_id', in: 'query', schema: { type: 'string', pattern: '^\\d{1,20}$' }, description: '可选：从该关键词匹配的 series_candidates 中选择专辑，避免同名电视剧混淆。' },
      ],
      responses: {
        '200': { description: '分集目录，需检查 complete 与 missing_episode_numbers', content: { 'application/json': { schema: {
          type: 'object', properties: {
            ok: { type: 'boolean' }, query: { type: 'string' }, platform: { const: 'iqiyi' },
            series: { type: 'object', properties: { album_id: { type: 'string' }, title: { type: 'string' }, year: { type: 'string' }, total_episodes: { type: ['integer', 'null'] } } },
            series_candidates: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, expected_total: { type: ['integer', 'null'] },
            complete: { type: 'boolean' }, partial: { type: 'boolean' }, missing_episode_numbers: { type: 'array', items: { type: 'integer' } },
            results: { type: 'array', items: { type: 'object', properties: { platform: { const: 'iqiyi' }, platform_name: { type: 'string' }, episode_number: { type: 'integer' }, title: { type: 'string' }, url: { type: 'string', format: 'uri' }, kind: { const: 'video' }, source: { const: 'native' } } } },
            warnings: { type: 'array', items: { type: 'string' } }, cached: { type: 'boolean' }, fetched_at: { type: 'string', format: 'date-time' }, took_ms: { type: 'integer' },
          },
        } } } },
        '400': { description: '参数错误或暂不支持此平台' }, '401': { description: '认证失败' },
        '404': { description: '未匹配到电视剧专辑' }, '503': { description: '上游不可用或无可用分集' },
      },
    } },
    '/v1/search': { get: {
      summary: '按不完整标题搜索官方播放页',
      description: '配置 API_KEY 时必须认证；未配置时可匿名访问。partial=true 时请检查 providers。limit 对每站生效。',
      security: [{ bearerAuth: [] }, { apiKey: [] }, {}],
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 80 }, example: '三体' },
        { name: 'platforms', in: 'query', schema: { type: 'string', default: 'all' }, description: 'all 或 tencent,iqiyi,youku,mango,bilibili 的逗号分隔子集' },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, minimum: 1, maximum: 20 }, description: '每个平台最多返回条数' },
      ],
      responses: Object.fromEntries([200, 400, 401, 503].map(code => [String(code), {
        description: ({ 200: '搜索完成，可能部分降级', 400: '参数错误', 401: '认证失败', 503: '所有所选平台不可用；请重试' } as Record<number, string>)[code],
        content: { 'application/json': { schema: { $ref: code === 200 || code === 503 ? '#/components/schemas/SearchResponse' : '#/components/schemas/Error' } } },
      }])),
    } },
  },
};
