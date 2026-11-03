import { PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform } from './types';
import { openapi } from './openapi';
import { CAPABILITIES, VERSION } from './aggregate';
import { DOCS_HTML, DOCS_CSS, DOCS_JS } from './documentation';
import { searchSeries, seriesCatalogue, validSeriesId } from './catalogue';
import { officialSearch } from './official';
import { searchResource, validResourceId } from './resources';
import { loadResourceConfig, publicResourceSources } from './resource-config';
import { RESOURCE_ADMIN_HTML, RESOURCE_ADMIN_CSS, RESOURCE_ADMIN_JS } from './resource-admin-ui';
import { handleResourceAdmin } from './resource-admin';
import { bilibiliSessionFetcher } from './providers';

export function createHandler(fetcher: Fetcher = fetch, cache?: CacheStore) {
  return async (request: Request, env: Env = {}): Promise<Response> => {
    const started = Date.now(),
      url = new URL(request.url),
      path = url.pathname.replace(/\/+$/, '') || '/';
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
      'X-Content-Type-Options': 'nosniff',
    };
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const fail = (code: string, message: string, status: number) =>
      reply({ ok: false, error: { code, message } }, status);
    if(path.startsWith('/v1/admin/'))return handleResourceAdmin(request,env,fetcher);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET')
      return reply({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405, {
        Allow: 'GET, OPTIONS',
      });
    if (['/', '/docs', '/assets/docs.css', '/assets/docs.js', '/admin', '/assets/resource-admin.css', '/assets/resource-admin.js'].includes(path)) {
      const html = path === '/' || path === '/docs' || path === '/admin';
      const admin = path === '/admin' || path.includes('resource-admin');
      return new Response(admin ? html ? RESOURCE_ADMIN_HTML : path.endsWith('.css') ? RESOURCE_ADMIN_CSS : RESOURCE_ADMIN_JS : html ? DOCS_HTML : path.endsWith('.css') ? DOCS_CSS : DOCS_JS, {
        headers: {
          'Content-Type': html
            ? 'text/html; charset=utf-8'
            : path.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        },
      });
    }
    if (path === '/health')
      return reply({ ok: true, service: 'cn-video-search', version: VERSION, upstream_checked: false });
    if (path === '/openapi.json') return reply(openapi);
    if (path === '/v1/platforms') return reply({ ok: true, platforms: Object.values(CAPABILITIES) });
    if (path === '/v1/resources') {
      try{const config=await loadResourceConfig(env);return reply({ok:true,source:'third_party',storage:env.RESOURCE_CONFIG?'kv':'defaults',revision:config.revision,sources:publicResourceSources(config)});}
      catch(e){return fail('RESOURCE_CONFIG_UNAVAILABLE','采集站配置暂时不可用。',503);}
    }
    if (path === '/v1')
      return reply({
        version: VERSION,
        aggregate: '/v1/search',
        default_view: 'official',
        views: ['official', 'series'],
        resource_search: '/v1/resources/search',
        resource_sources: '/v1/resources',
        platforms: Object.values(CAPABILITIES),
        docs: '/',
        openapi: '/openapi.json',
      });
    const singleId = path.match(/^\/v1\/([a-z]+)\/search$/)?.[1];
    const single = singleId && Object.hasOwn(PLATFORMS, singleId) ? (singleId as Platform) : undefined;
    const detail = path.match(/^\/v1\/([a-z]+)\/series\/([^/]+)$/);
    const detailPlatform =
      detail && Object.hasOwn(PLATFORMS, detail[1]) ? (detail[1] as Platform) : undefined;
    const resourceSearch = path === '/v1/resources/search';
    const resourceDetail = path.match(/^\/v1\/resources\/([a-z0-9_-]+)\/items\/([^/]+)$/);
    if (path !== '/v1/search' && !single && !detailPlatform && !resourceSearch && !resourceDetail)
      return fail('NOT_FOUND', 'Endpoint not found.', 404);
    if (env.API_KEY) {
      const supplied =
        request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied !== env.API_KEY)
        return fail('UNAUTHORIZED', 'Missing or invalid API key.', 401);
    }
    const allowed = new Set(
      resourceDetail ? [] : resourceSearch ? ['q', 'sources', 'page'] : detailPlatform
        ? ['q', 'ai']
        : single
          ? ['q', 'view', 'limit', 'page', 'ai']
          : ['q', 'view', 'platforms', 'limit', 'page', 'ai'],
    );
    for (const name of url.searchParams.keys()) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1)
        return fail('INVALID_PARAMETER', `Unknown or repeated parameter: ${name}`, 400);
    }
    const raw = url.searchParams.get('q') || '',
      query = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (
      (!query && !detailPlatform && !resourceDetail) ||
      query.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(raw) ||
      (query && !/[\p{L}\p{N}]/u.test(query))
    )
      return fail(
        'INVALID_QUERY',
        'q must contain 1–80 characters with letters or numbers, without control characters.',
        400,
      );
    if (resourceSearch || resourceDetail) {
      let config;
      try{config=await loadResourceConfig(env);}catch{return fail('RESOURCE_CONFIG_UNAVAILABLE','采集站配置暂时不可用。',503);}
      const available=config.sources.filter(s=>s.enabled),selection=url.searchParams.get('sources')??'all';
      const selected = resourceDetail ? [resourceDetail[1]] : selection==='all'?available.map(s=>s.id):selection.split(',').map(s=>s.trim());
      if ((!selected.length && selection!=='all') || selected.some(s=>!available.some(v=>v.id===s)))
        return fail('INVALID_SOURCES','来源不存在或已停用，请读取 /v1/resources 获取当前启用来源。',400);
      if (resourceDetail && !validResourceId(resourceDetail[2])) return fail('INVALID_RESOURCE_ID', 'Invalid resource ID.', 400);
      const page = url.searchParams.get('page') ?? '1';
      if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 1000) return fail('INVALID_PAGE', 'page must be 1–1000.', 400);
      const providers = await Promise.all([...new Set(selected)].map(s => searchResource(s, query, Number(page), env, fetcher, resourceDetail?.[2], available.find(v=>v.id===s))));
      const results = providers.flatMap(p => p.results), unavailable = providers.length>0&&providers.every(p => p.status === 'unavailable');
      if (resourceDetail) return reply({ ok: results.length > 0, source: 'third_party', source_id: selected[0],
        item: results[0] || null, warnings: providers[0].warnings, took_ms: Date.now() - started }, unavailable ? 503 : results.length ? 200 : 404);
      return reply({ ok: !unavailable, view: 'resources', query, page: Number(page), config_revision: config.revision, source_policy: 'third_party_resource_sites',
        partial: providers.some(p => p.status === 'unavailable'), total: results.length, results,
        providers: providers.map(({ results: _r, ...p }) => p), took_ms: Date.now() - started }, unavailable ? 503 : 200);
    }
    if (detailPlatform && detail) {
      const aiMode = url.searchParams.get('ai') ?? 'off';
      if (!['on', 'off'].includes(aiMode)) return fail('INVALID_AI', 'ai must be on or off.', 400);
      if (!validSeriesId(detailPlatform, detail[2]))
        return fail('INVALID_SERIES_ID', 'Invalid series ID for this platform.', 400);
      const result = await seriesCatalogue(detailPlatform, detail[2], query, {...env, AI_ENABLED: aiMode as 'on' | 'off'}, detailPlatform === 'bilibili' ? bilibiliSessionFetcher(env, fetcher) : fetcher, cache);
      return reply({ ...result, ai_mode: aiMode, took_ms: Date.now() - started }, result.ok ? 200 : 503);
    }
    const selection = url.searchParams.get('platforms') ?? 'all';
    const ids = single
      ? [single]
      : selection === 'all'
        ? Object.keys(PLATFORMS)
        : selection.split(',').map((s) => s.trim());
    if (!ids.length || ids.some((id) => !Object.hasOwn(PLATFORMS, id)))
      return fail(
        'INVALID_PLATFORMS',
        `platforms must be all or a subset of ${Object.keys(PLATFORMS).join(',')}.`,
        400,
      );
    const platforms = [...new Set(ids)] as Platform[];
    const view = url.searchParams.get('view') ?? 'official';
    if (!['official', 'series'].includes(view))
      return fail('INVALID_VIEW', 'view must be official or series.', 400);
    if (view === 'official') {
      if (url.searchParams.has('ai')) return fail('INVALID_PARAMETER', 'ai is available for series search and detail only.', 400);
      const page = url.searchParams.get('page') ?? '1';
      if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 1000)
        return fail('INVALID_PAGE', 'page must be an integer from 1 to 1000.', 400);
      const providers = await Promise.all(
        platforms.map((p) => officialSearch(p, query, Number(page), env, fetcher)),
      );
      const results = providers.flatMap((p) => p.results),
        unavailable = providers.every((p) => p.status === 'unavailable');
      return reply(
        {
          ok: !unavailable,
          query,
          view,
          page: Number(page),
          source_policy: 'same_platform_official_only',
          partial: providers.some((p) => ['unavailable', 'degraded'].includes(p.status)),
          total: results.length,
          took_ms: Date.now() - started,
          results,
          providers: providers.map(({ results: _r, ...p }) => p),
        },
        unavailable ? 503 : 200,
      );
    }
    if (url.searchParams.has('page'))
      return fail('INVALID_PARAMETER', 'page is available for official search only.', 400);
    if (view === 'series') {
      const aiMode = url.searchParams.get('ai') ?? 'off';
      if (!['on', 'off'].includes(aiMode)) return fail('INVALID_AI', 'ai must be on or off.', 400);
      const limit = url.searchParams.get('limit') ?? '5';
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 20)
        return fail('INVALID_LIMIT', 'limit must be an integer from 1 to 20.', 400);
      const providers = await Promise.all(
        platforms.map((p) => searchSeries(p, query, Number(limit), {...env, AI_ENABLED: aiMode as 'on' | 'off'}, p === 'bilibili' ? bilibiliSessionFetcher(env, fetcher) : fetcher, cache)),
      );
      const results = providers.flatMap((p) => p.results),
        unavailable = providers.every((p) => p.status === 'unavailable');
      return reply(
        {
          ok: !unavailable,
          query,
          view,
          ai_mode: aiMode,
          partial: providers.some((p) => ['unavailable', 'degraded'].includes(p.status)),
          total: results.length,
          limit: Number(limit),
          took_ms: Date.now() - started,
          results,
          providers: providers.map(({ results: _r, ...metadata }) => metadata),
        },
        unavailable ? 503 : 200,
      );
    }
    return fail('INVALID_VIEW', 'view must be official or series.', 400);
  };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createHandler(fetch, caches.default)(request, env);
  },
} satisfies ExportedHandler<Env>;
