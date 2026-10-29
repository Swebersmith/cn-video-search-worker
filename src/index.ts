import { PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform } from './types';
import { openapi } from './openapi';
import { iqiyiEpisodes, SeriesNotFound } from './episodes';
import { UpstreamError } from './providers';
import { CAPABILITIES, queryPlatform, VERSION, type Mode } from './aggregate';
import { DOCS_HTML, DOCS_CSS, DOCS_JS } from './documentation';

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
    if (path === '/v1') return reply({ version: VERSION, aggregate: '/v1/search', modes: ['all', 'search', 'episodes'], default_mode: 'all', platforms: Object.values(CAPABILITIES), docs: '/', openapi: '/openapi.json' });
    const singleId = path.match(/^\/v1\/([a-z]+)\/search$/)?.[1];
    const single = singleId && Object.hasOwn(PLATFORMS, singleId) ? singleId as Platform : undefined;
    const legacyEpisodes = path === '/v1/episodes';
    if (path !== '/v1/search' && !single && !legacyEpisodes) return fail('NOT_FOUND', 'Endpoint not found.', 404);
    if (env.API_KEY) {
      const supplied = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied !== env.API_KEY) return fail('UNAUTHORIZED', 'Missing or invalid API key.', 401);
    }
    const allowed = new Set(legacyEpisodes ? ['q', 'platform', 'album_id'] : single ? ['q', 'mode', 'limit', 'album_id'] : ['q', 'mode', 'platforms', 'limit', 'album_id']);
    for (const name of url.searchParams.keys()) {
      if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) return fail('INVALID_PARAMETER', `Unknown or repeated parameter: ${name}`, 400);
    }
    const raw = url.searchParams.get('q') || '', query = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/.test(raw) || !/[\p{L}\p{N}]/u.test(query)) return fail('INVALID_QUERY', 'q must contain 1–80 characters with letters or numbers, without control characters.', 400);
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
