import { canonical, score, text } from './normalize';
import { json, request, UpstreamError } from './providers';
import { bounded, type CacheStore, type Env, type Fetcher } from './types';

type Obj = Record<string, unknown>;
const object = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};
const positive = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : null;
};
export class SeriesNotFound extends Error {}
interface Series {
  album_id: string;
  title: string;
  year: string;
  total_episodes: number | null;
}
interface Episode {
  platform: 'iqiyi';
  platform_name: '爱奇艺';
  episode_number: number;
  title: string;
  url: string;
  kind: 'video';
  source: 'native';
}
export interface EpisodesResult {
  ok: boolean;
  query: string;
  platform: 'iqiyi';
  series: Series;
  series_candidates: Series[];
  total: number;
  expected_total: number | null;
  complete: boolean;
  partial: boolean;
  missing_episode_numbers: number[];
  results: Episode[];
  warnings: string[];
  cached: boolean;
  fetched_at: string;
}

export async function iqiyiEpisodes(query: string, albumId: string | undefined, env: Env, fetcher: Fetcher, cache?: CacheStore): Promise<EpisodesResult> {
  const key = new Request(`https://cn-video-search.internal/episodes/v1?q=${encodeURIComponent(query)}&album=${albumId || ''}`);
  const ttl = bounded(env.CACHE_TTL_SECONDS, 300, 30, 3600);
  if (cache) {
    try {
      const r = await cache.match(key);
      if (r) {
        const saved = await r.json() as EpisodesResult;
        const age = Date.now() - Date.parse(saved.fetched_at);
        if (saved.complete && age >= 0 && age <= ttl * 1000) return { ...saved, cached: true };
      }
    } catch { /* Cache is optional. */ }
  }
  const data = object(json(await request(`https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?key=${encodeURIComponent(query)}&version=14.9.0&size=20&pageNum=1&source=pcw`, env, fetcher)));
  const templates = object(data.data).templates;
  if (!Array.isArray(templates)) throw new UpstreamError('SCHEMA_CHANGED');
  const candidates: { series: Series; preview: unknown[] }[] = [];
  for (const template of templates) {
    const a = object(object(template).albumInfo);
    // A TV series can share its name with movies, clips and recaps. Only use the TV album.
    if (String(a.channel).split(',').at(-1) !== '2' || (a.siteId && a.siteId !== 'iqiyi')) continue;
    const id = typeof a.playUrl === 'string' ? a.playUrl.match(/(?:^|;)albumid=(\d+);?/)?.[1] : undefined;
    const rawId = id || (typeof a.qipuId === 'string' || (typeof a.qipuId === 'number' && Number.isSafeInteger(a.qipuId)) ? String(a.qipuId) : '');
    const title = text(a.title);
    if (!/^\d{1,20}$/.test(rawId) || !title || score(query, title) < 0.12) continue;
    if (candidates.some(c => c.series.album_id === rawId)) continue;
    candidates.push({ series: { album_id: rawId, title, year: text(object(a.year).value), total_episodes: positive(a.totalNumber) }, preview: Array.isArray(a.videos) ? a.videos : [] });
  }
  candidates.sort((a, b) => score(query, b.series.title) - score(query, a.series.title));
  const selected = albumId ? candidates.find(c => c.series.album_id === albumId) : candidates[0];
  if (!selected) throw new SeriesNotFound('No matching iQIYI TV series found.');

  const warnings: string[] = [];
  const episodes = new Map<number, Episode>();
  const urls = new Map<string, number>();
  let conflicting = false;
  const add = (items: unknown[], preview: boolean) => {
    for (const raw of items) {
      const v = object(raw);
      if (!preview && ((v.contentType !== undefined && Number(v.contentType) !== 1) || v.effective === false)) continue;
      const number = positive(preview ? v.number : v.order);
      const c = canonical(preview ? v.pageUrl : v.playUrl, 'iqiyi');
      const title = text(preview ? v.title : v.name);
      if (!number || !c || !title || /预告|花絮|抢先看/.test(title)) continue;
      const old = episodes.get(number), oldNumber = urls.get(c.url);
      if ((old && old.url !== c.url) || (oldNumber !== undefined && oldNumber !== number)) {
        conflicting = true; continue;
      }
      episodes.set(number, { platform: 'iqiyi', platform_name: '爱奇艺', episode_number: number, title, url: c.url, kind: 'video', source: 'native' });
      urls.set(c.url, number);
    }
  };
  let expected = selected.series.total_episodes;
  let catalogVerified = false;
  let pagesVerified = true;
  const fetchPage = async (page: number): Promise<Obj> => {
    const d = object(json(await request(`https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${selected.series.album_id}&page=${page}&size=100`, env, fetcher)));
    if (d.code !== 'A00000') throw new UpstreamError('ALBUM_API_REJECTED');
    const album = object(d.data);
    if (String(album.albumId) !== selected.series.album_id || !Array.isArray(album.epsodelist)) throw new UpstreamError('ALBUM_SCHEMA_CHANGED');
    return album;
  };
  try {
    const first = await fetchPage(1);
    catalogVerified = true;
    const catalogTotal = positive(first.total);
    if (catalogTotal && expected && catalogTotal !== expected) warnings.push('EPISODE_TOTAL_MISMATCH');
    expected = Math.max(catalogTotal || 0, expected || 0) || null;
    add(first.epsodelist as unknown[], false);
    // Bound requests to five pages (500 episodes); a bounded response must never claim completeness.
    const pages = Math.min(5, Math.ceil((catalogTotal || 100) / 100));
    const rest = await Promise.allSettled(Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2)));
    for (const page of rest) {
      if (page.status === 'fulfilled') add(page.value.epsodelist as unknown[], false);
      else { pagesVerified = false; warnings.push(`album:${page.reason instanceof UpstreamError ? page.reason.message : 'PAGE_ERROR'}`); }
    }
    if ((catalogTotal && catalogTotal > 500) || (!catalogTotal && first.hasMore === true)) {
      pagesVerified = false; warnings.push('EPISODE_PAGE_LIMIT_REACHED');
    }
  } catch (e) {
    warnings.push(`album:${e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR'}`);
    warnings.push('SEARCH_PREVIEW_FALLBACK');
    add(selected.preview, true);
  }
  if (conflicting) warnings.push('CONFLICTING_EPISODE_DATA');
  const results = [...episodes.values()].sort((a, b) => a.episode_number - b.episode_number);
  const missing = expected ? Array.from({ length: expected }, (_, i) => i + 1).filter(n => !episodes.has(n)) : [];
  const complete = catalogVerified && pagesVerified && !conflicting && expected !== null && results.length === expected && missing.length === 0 && !warnings.includes('EPISODE_TOTAL_MISMATCH');
  if (!complete) warnings.push('EPISODE_LIST_INCOMPLETE');
  const result: EpisodesResult = {
    ok: results.length > 0, query, platform: 'iqiyi', series: { ...selected.series, total_episodes: expected },
    series_candidates: candidates.map(c => c.series), total: results.length, expected_total: expected,
    complete, partial: !complete, missing_episode_numbers: missing, results,
    warnings: [...new Set(warnings)], cached: false, fetched_at: new Date().toISOString(),
  };
  if (complete && cache) {
    try { await cache.put(key, new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })); } catch { /* Optional cache. */ }
  }
  return result;
}
