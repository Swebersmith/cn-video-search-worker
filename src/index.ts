import { PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform } from './types';
import { openapi } from './openapi';
import { iqiyiEpisodes, SeriesNotFound } from './episodes';
import { UpstreamError } from './providers';
import { CAPABILITIES, queryPlatform, VERSION, type Mode } from './aggregate';
import { DOCS_HTML, DOCS_CSS, DOCS_JS } from './documentation';
import { searchSeries, seriesCatalogue, validSeriesId } from './catalogue';
import { officialSearch } from './official';

export function createHandler(fetcher: Fetcher = fetch, cache?: CacheStore) {
  return async (request: Request, env: Env = {}): Promise<Response> => {
    const started = Date.now(), url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
    const headers = {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type', 'X-Content-Type-Options': 'nosniff',
    };
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const fail = (code: string, message: string, status: number) => reply({ ok: false, error: { code, message } }, status);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return reply({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405, { Allow: 'GET, OPTIONS' });
    if (['/', '/docs', '/assets/docs.css', '/assets/docs.js'].includes(path)) {
      const html = path === '/' || path === '/docs';
      return new Response(html ? DOCS_HTML : path.endsWith('.css') ? DOCS_CSS : DOCS_JS, { headers: {
        'Content-Type': html ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      } });
    }
    if (path === '/health') return reply({ ok: true, service: 'cn-video-search', version: VERSION, upstream_checked: false });
    if (path === '/openapi.json') return reply(openapi);
    if (path === '/v1/platforms') return reply({ ok: true, platforms: Object.values(CAPABILITIES) });
    if (path === '/v1') return reply({ version: VERSION, aggregate: '/v1/search', default_view: 'official', views: ['official', 'series', 'videos'], platforms: Object.values(CAPABILITIES), docs: '/', openapi: '/openapi.json' });
    const singleId = path.match(/^\/v1\/([a-z]+)\/search$/)?.[1];
    const single = singleId && Object.hasOwn(PLATFORMS, singleId) ? singleId as Platform : undefined;
    const legacyEpisodes = path === '/v1/episodes';
    const detail = path.match(/^\/v1\/([a-z]+)\/series\/([^/]+)$/);
    const detailPlatform = detail && Object.hasOwn(PLATFORMS, detail[1]) ? detail[1] as Platform : undefined;
    if (path !== '/v1/search' && !single && !legacyEpisodes && !detailPlatform) return fail('NOT_FOUND', 'Endpoint not found.', 404);
    if (env.API_KEY) {
      const supplied = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied !== env.API_KEY) return fail('UNAUTHORIZED', 'Missing or invalid API key.', 401);
    }
    const allowed = new Set(detailPlatform ? ['q'] : legacyEpisodes ? ['q', 'platform', 'album_id'] : single ? ['q', 'view', 'mode', 'limit', 'album_id', 'page'] : ['q', 'view', 'mode', 'platforms', 'limit', 'album_id', 'page']);
    for (const name of url.searchParams.keys()) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) return fail('INVALID_PARAMETER', `Unknown or repeated parameter: ${name}`, 400);
    }
    const raw = url.searchParams.get('q') || '', query = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if ((!query && !detailPlatform) || query.length > 80 || /[\u0000-\u001f\u007f]/.test(raw) || (query && !/[\p{L}\p{N}]/u.test(query))) return fail('INVALID_QUERY', 'q must contain 1–80 characters with letters or numbers, without control characters.', 400);
    if (detailPlatform && detail) {
      if (!validSeriesId(detailPlatform, detail[2])) return fail('INVALID_SERIES_ID', 'Invalid series ID for this platform.', 400);
      const result = await seriesCatalogue(detailPlatform, detail[2], query, env, fetcher, cache);
      return reply({ ...result, took_ms: Date.now() - started }, result.ok ? 200 : 503);
    }
    const albumId = url.searchParams.get('album_id') ?? undefined;
    if (albumId !== undefined && !/^\d{1,20}$/.test(albumId)) return fail('INVALID_ALBUM_ID', 'album_id must contain 1–20 digits.', 400);
    if (legacyEpisodes) {
      if ((url.searchParams.get('platform') ?? 'iqiyi') !== 'iqiyi') return fail('UNSUPPORTED_PLATFORM', 'Episode catalogs currently support iQIYI TV series only.', 400);
      try {
        const result = await iqiyiEpisodes(query, albumId, env, fetcher, cache);
        return reply({ ...result, took_ms: Date.now() - started }, result.ok ? 200 : 503, { Deprecation: 'true', Link: '</v1/iqiyi/search?mode=episodes>; rel="successor-version"' });
      } catch (e) {
        if (e instanceof SeriesNotFound) return fail('SERIES_NOT_FOUND', e.message, 404);
        if (e instanceof UpstreamError) return fail('UPSTREAM_UNAVAILABLE', e.message, 503);
        return fail('INTERNAL_ERROR', 'Unexpected episode catalog error.', 500);
      }
    }
    const mode = url.searchParams.get('mode') ?? 'all';
    if (!['all', 'search', 'episodes'].includes(mode)) return fail('INVALID_MODE', 'mode must be all, search, or episodes.', 400);
    const limit = url.searchParams.get('limit') ?? '5';
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 20) return fail('INVALID_LIMIT', 'limit must be an integer from 1 to 20.', 400);
    const selection = url.searchParams.get('platforms') ?? 'all';
    const ids = single ? [single] : selection === 'all' ? Object.keys(PLATFORMS) : selection.split(',').map(s => s.trim());
    if (!ids.length || ids.some(id => !Object.hasOwn(PLATFORMS, id))) return fail('INVALID_PLATFORMS', `platforms must be all or a subset of ${Object.keys(PLATFORMS).join(',')}.`, 400);
    const platforms = [...new Set(ids)] as Platform[];
    const view = url.searchParams.get('view') ?? (url.searchParams.has('mode') ? 'videos' : 'official');
    if (!['official', 'series', 'videos'].includes(view)) return fail('INVALID_VIEW', 'view must be official, series or videos.', 400);
    if (view === 'official') {
      if (albumId || url.searchParams.has('mode')) return fail('INVALID_PARAMETER', 'Official search uses q, page and platforms.', 400);
      const page = url.searchParams.get('page') ?? '1';
      if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 1000) return fail('INVALID_PAGE', 'page must be an integer from 1 to 1000.', 400);
      const providers = await Promise.all(platforms.map(p => officialSearch(p, query, Number(page), env, fetcher)));
      const results = providers.flatMap(p => p.results), unavailable = providers.every(p => p.status === 'unavailable');
      return reply({ok:!unavailable,query,view,page:Number(page),source_policy:'same_platform_official_only',
        partial:providers.some(p => p.status === 'unavailable'),total:results.length,took_ms:Date.now()-started,results,
        providers:providers.map(({results:_r,...p})=>p)},unavailable?503:200);
    }
    if (url.searchParams.has('page')) return fail('INVALID_PARAMETER', 'page is available for official search only.', 400);
    if (view === 'series') {
      if (albumId || url.searchParams.has('mode')) return fail('INVALID_PARAMETER', 'Series discovery uses q, limit and platforms. Follow detail_url to retrieve episodes.', 400);
      const providers = await Promise.all(platforms.map(p => searchSeries(p, query, Number(limit), env, fetcher, cache)));
      const results = providers.flatMap(p => p.results), unavailable = providers.every(p => p.status === 'unavailable');
      return reply({ ok: !unavailable, query, view, partial: providers.some(p => ['unavailable', 'degraded'].includes(p.status)), total: results.length, limit: Number(limit), took_ms: Date.now() - started, results, providers: providers.map(({ results: _r, ...metadata }) => metadata) }, unavailable ? 503 : 200);
    }
    if (albumId && (mode === 'search' || !platforms.includes('iqiyi'))) return fail('INVALID_ALBUM_ID', 'album_id is available for iQIYI catalog queries only.', 400);
    try {
      const providers = await Promise.all(platforms.map(p => queryPlatform(p, query, mode as Mode, Number(limit), albumId, env, fetcher, cache)));
      const results = providers.flatMap(p => p.results);
      const unavailable = providers.every(p => p.status === 'unavailable' || p.status === 'unsupported');
      const unsupported = providers.every(p => p.status === 'unsupported');
      return reply({
        ok: !unavailable, query, mode, partial: providers.some(p => ['degraded', 'unavailable', 'stale', 'unsupported'].includes(p.status)),
        total: results.length, limit: Number(limit), took_ms: Date.now() - started, results,
        providers: providers.map(({ results: _r, ...metadata }) => metadata),
      }, unsupported ? 422 : unavailable ? 503 : 200, unavailable && !unsupported ? { 'Retry-After': '30' } : {});
    } catch { return fail('INTERNAL_ERROR', 'Unexpected query error.', 500); }
  };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> { return createHandler(fetch, caches.default)(request, env); },
} satisfies ExportedHandler<Env>;
