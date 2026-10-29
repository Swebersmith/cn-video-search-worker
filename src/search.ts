import { PLATFORMS, bounded, type CacheStore, type Env, type Fetcher, type Platform, type ProviderResult } from './types';
import { nativeSearch, UpstreamError, PartialUpstreamError, type IqiyiSearchLoader } from './providers';

const errorCode = (e: unknown) => e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR';

export async function searchPlatform(platform: Platform, query: string, env: Env, fetcher: Fetcher, cache?: CacheStore, loadIqiyi?: IqiyiSearchLoader): Promise<ProviderResult> {
  const fresh = bounded(env.CACHE_TTL_SECONDS, 300, 30, 3600);
  const staleTtl = Math.max(fresh, bounded(env.STALE_TTL_SECONDS, 86400, 30, 604800));
  // Include backend configuration but never credentials in cache keys. This origin is internal to Cache API.
  const key = new Request(`https://cn-video-search.internal/native-only/v4/${platform}?q=${encodeURIComponent(query)}`);
  let saved: ProviderResult | undefined;
  if (cache) {
    try {
      const entry = await cache.match(key);
      if (entry) {
        const candidate = await entry.json() as ProviderResult;
        const age = (Date.now() - Date.parse(candidate.fetched_at)) / 1000;
        if (Number.isFinite(age) && age >= 0 && age <= staleTtl) saved = candidate;
        if (saved && age <= fresh) return { ...saved, cached: true };
      }
    } catch { /* Cache failures must never prevent live searches. */ }
  }
  const warnings: string[] = [];
  let nativeOk = false;
  let results: ProviderResult['results'] = [];
  try { results = await nativeSearch(platform, query, env, fetcher, loadIqiyi); nativeOk = true; }
  catch (e) {
    warnings.push(`native:${errorCode(e)}`);
    if (e instanceof PartialUpstreamError) results = e.results;
  }

  if (!results.length && !nativeOk && saved?.results.length) {
    return { ...saved, status: 'stale', warnings: [...new Set([...saved.warnings, ...warnings, 'STALE_RESULTS_NOT_REVALIDATED'])], cached: true };
  }
  const status: ProviderResult['status'] = !nativeOk && !results.length ? 'unavailable'
    : !nativeOk ? 'degraded' : results.length ? 'ok' : 'empty';
  const result: ProviderResult = {
    platform, status, results, warnings, cached: false, fetched_at: new Date().toISOString(),
    search_url: PLATFORMS[platform].search + encodeURIComponent(query),
  };
  if (cache && (nativeOk || results.length)) {
    try {
      // Store empty responses briefly; storing them for a day could hide recovery.
      await cache.put(key, new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${results.length ? staleTtl : fresh}` } }));
    } catch { /* Search results are usable even when cache storage fails. */ }
  }
  return result;
}
