import { PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform } from './types';
import { searchPlatform } from './search';
import { openapi } from './openapi';
import { iqiyiEpisodes, SeriesNotFound } from './episodes';
import { UpstreamError } from './providers';

export function createHandler(fetcher: Fetcher = fetch, cache?: CacheStore) {
  return async (request: Request, env: Env = {}): Promise<Response> => {
    const started = Date.now();
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
      'X-Content-Type-Options': 'nosniff',
    };
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const fail = (code: string, message: string, status: number) => reply({ ok: false, error: { code, message } }, status);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return reply({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405, { Allow: 'GET, OPTIONS' });
    if (url.pathname === '/health') return reply({ ok: true, service: 'cn-video-search', version: '1.1.0', upstream_checked: false });
    if (url.pathname === '/openapi.json') return reply(openapi);
    if (url.pathname === '/v1/platforms') return reply({ ok: true, platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, name: p.name, domain: p.domain })) });
    if (url.pathname === '/') return reply({ service: '国内五大影视平台官方播放页搜索 API', version: '1.1.0', search: '/v1/search?q=三体', episodes: '/v1/episodes?q=海市蜃楼', docs: '/openapi.json', platforms: '/v1/platforms', note: '上游页面、版权和地区限制会影响结果；不承诺永久可用。' });
    if (!['/v1/search', '/v1/episodes'].includes(url.pathname)) return fail('NOT_FOUND', 'Endpoint not found.', 404);
    if (env.API_KEY) {
      const supplied = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied !== env.API_KEY) return fail('UNAUTHORIZED', 'Missing or invalid API key.', 401);
    }
    const episodeMode = url.pathname === '/v1/episodes';
    const allowed = new Set(episodeMode ? ['q', 'platform', 'album_id'] : ['q', 'platforms', 'limit']);
    for (const name of url.searchParams.keys()) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) return fail('INVALID_PARAMETER', `Unknown or repeated parameter: ${name}`, 400);
    }
    const raw = url.searchParams.get('q') || '';
    const query = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/.test(raw) || !/[\p{L}\p{N}]/u.test(query)) return fail('INVALID_QUERY', 'q must contain 1–80 characters with letters or numbers, without control characters.', 400);
    if (episodeMode) {
      if ((url.searchParams.get('platform') ?? 'iqiyi') !== 'iqiyi') return fail('UNSUPPORTED_PLATFORM', 'Episode catalogs currently support iQIYI TV series only.', 400);
      const albumId = url.searchParams.get('album_id') ?? undefined;
      if (albumId !== undefined && !/^\d{1,20}$/.test(albumId)) return fail('INVALID_ALBUM_ID', 'album_id must contain 1–20 digits.', 400);
      try {
        const result = await iqiyiEpisodes(query, albumId, env, fetcher, cache);
        return reply({ ...result, took_ms: Date.now() - started }, result.ok ? 200 : 503);
      } catch (e) {
        if (e instanceof SeriesNotFound) return fail('SERIES_NOT_FOUND', e.message, 404);
        if (e instanceof UpstreamError) return fail('UPSTREAM_UNAVAILABLE', e.message, 503);
        return fail('INTERNAL_ERROR', 'Unexpected episode catalog error.', 500);
      }
    }
    const limitValue = url.searchParams.get('limit') ?? '5';
    if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 20) return fail('INVALID_LIMIT', 'limit must be an integer from 1 to 20.', 400);
    const selection = url.searchParams.get('platforms') ?? 'all';
    const ids = selection === 'all' ? Object.keys(PLATFORMS) : selection.split(',').map(s => s.trim());
    if (!ids.length || ids.some(id => !Object.hasOwn(PLATFORMS, id))) return fail('INVALID_PLATFORMS', `platforms must be all or a subset of ${Object.keys(PLATFORMS).join(',')}.`, 400);
    const platforms = [...new Set(ids)] as Platform[];
    try {
      const providers = await Promise.all(platforms.map(p => searchPlatform(p, query, env, fetcher, cache)));
      const results = providers.flatMap(p => p.results.slice(0, Number(limitValue))).sort((a, b) => b.score - a.score || a.platform.localeCompare(b.platform));
      const unavailable = providers.every(p => p.status === 'unavailable');
      return reply({
        ok: !unavailable, query, partial: providers.some(p => ['degraded', 'unavailable', 'stale'].includes(p.status)),
        total: results.length, limit: Number(limitValue), took_ms: Date.now() - started, results,
        providers: providers.map(({ results: items, ...rest }) => ({ ...rest, count: Math.min(items.length, Number(limitValue)), available_count: items.length, truncated: items.length > Number(limitValue) })),
      }, unavailable ? 503 : 200, unavailable ? { 'Retry-After': '30' } : {});
    } catch { return fail('INTERNAL_ERROR', 'Unexpected search error.', 500); }
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createHandler(fetch, caches.default)(request, env);
  },
} satisfies ExportedHandler<Env>;
