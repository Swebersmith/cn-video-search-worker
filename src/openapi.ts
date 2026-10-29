import { PLATFORMS } from './types';
import { CAPABILITIES, VERSION } from './aggregate';
const platform = { type: 'string', enum: Object.keys(PLATFORMS) };
const nullableInt = { type: ['integer', 'null'] };
const numbers = { type: 'array', items: { type: 'integer' } };
const strings = { type: 'array', items: { type: 'string' } };
const security = [{ bearerAuth: [] }, { apiKey: [] }, {}];
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string, description: string) => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const searchParameters = [
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
    schema: { type: 'string', enum: ['official', 'series'], default: 'official' },
    description: '官网综合搜索，或 AI 辅助筛选长影视作品的目录。',
  },
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
    description: '仅 official，读取官网一页。',
  },
  {
    name: 'platforms',
    in: 'query',
    schema: { type: 'string', default: 'all' },
    description: '仅总接口：all 或逗号分隔平台标识。',
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    description: '仅 series 的每站作品数，不限制详情目录；official 忽略。',
  },
];
const searchContract = {
  summary: '聚合五站官网搜索或长影视目录',
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
      '仅 official、series 两种模式。目录筛选电影、电视剧、综艺、动漫、纪录片，排除短剧及普通短视频。DeepSeek 仅分类和识别官方候选，不生成链接。',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    schemas: {
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
          platform,
          episode_number: nullableInt,
          title: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          episode_type: { enum: ['main', 'extra', 'preview'] },
          recognition: { enum: ['structured', 'ai'] },
        },
      },
      OfficialResult: {
        type: 'object',
        properties: {
          platform,
          platform_name: { type: 'string' },
          rank: { type: 'integer' },
          content_type: { const: 'official' },
          title: { type: 'string' },
          url: { type: ['string', 'null'] },
          type_name: { type: 'string' },
          raw: { description: '官网原始卡片，保留全部类型和原始顺序。' },
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
          episodes: { type: 'array', items: ref('Episode'), description: '正片与附加目录。' },
          previews: {
            type: 'array',
            items: ref('Episode'),
            description: '明确标为预告的官方链接，与正片分开。',
          },
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
          view: { enum: ['official', 'series'] },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          partial: { type: 'boolean' },
          total: { type: 'integer', description: '本页返回卡片或作品数量，不是某部剧总集数。' },
          source_policy: { const: 'same_platform_official_only' },
          took_ms: { type: 'integer' },
          results: { type: 'array', items: { oneOf: [ref('Series'), ref('OfficialResult')] } },
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
                ai: ref('AI'),
                cached: { type: 'boolean' },
                fetched_at: { type: 'string' },
                page: { type: 'integer' },
                has_more: { type: ['boolean', 'null'] },
                source: { type: 'string' },
                execution: { type: 'string' },
                source_url: { type: ['string', 'null'] },
                upstream: { description: 'official 模式完整官网响应。' },
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
          '使用搜索返回的 detail_url。AI 仅选取已验证的官方候选，预告单列；缺少 Secret 或 AI 失败时使用规则处理并返回 ai 状态。',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
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
