import { PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform, type ProviderResult, type Video } from './types';
import { searchPlatform } from './search';
import { iqiyiEpisodes, SeriesNotFound, type EpisodesResult } from './episodes';
import { iqiyiSearchData, UpstreamError } from './providers';
import { score } from './normalize';

export const VERSION = '1.2.0';
export type Mode = 'all' | 'search' | 'episodes';
export const CAPABILITIES = Object.fromEntries(Object.entries(PLATFORMS).map(([id, p]) => [id, {
  id, name: p.name, domain: p.domain, endpoint: `/v1/${id}/search`, search: true, episodes: id === 'iqiyi',
  note: id === 'iqiyi' ? '支持电视剧专辑目录、集数排序和完整性检查。' : '支持播放页搜索；完整分集目录暂未接入。',
}])) as Record<Platform, { id: string; name: string; domain: string; endpoint: string; search: boolean; episodes: boolean; note: string }>;

type OperationStatus = ProviderResult['status'] | 'unsupported' | 'skipped';
interface Operation { status: OperationStatus; count: number; warnings: string[]; cached?: boolean; fetched_at?: string }
export interface UnifiedVideo extends Video {
  content_type: 'search' | 'episode';
  episode_number?: number;
  album_id?: string;
  series_title?: string;
}
export interface UnifiedProvider {
  platform: Platform;
  status: OperationStatus;
  count: number;
  available_count: number;
  truncated: boolean;
  cached: boolean;
  fetched_at: string;
  search_url: string;
  warnings: string[];
  operations: { search: Operation; episodes: Operation };
  catalog?: Omit<EpisodesResult, 'results' | 'ok' | 'query' | 'platform'>;
  results: UnifiedVideo[];
}
const code = (e: unknown) => e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR';
const omitted = (status: 'skipped' | 'unsupported'): Operation => ({ status, count: 0, warnings: status === 'unsupported' ? ['EPISODE_CATALOG_NOT_SUPPORTED'] : [] });

export async function queryPlatform(platform: Platform, query: string, mode: Mode, limit: number, albumId: string | undefined, env: Env, fetcher: Fetcher, cache?: CacheStore): Promise<UnifiedProvider> {
  // Lazy, request-local sharing: all mode fetches the iQIYI search payload only once, and cache hits do no I/O.
  let payload: Promise<unknown> | undefined;
  const loadIqiyi = () => payload ??= iqiyiSearchData(query, env, fetcher);
  const tasks = await Promise.allSettled([
    mode === 'episodes' ? Promise.resolve(undefined) : searchPlatform(platform, query, env, fetcher, cache, loadIqiyi),
    mode === 'search' || !CAPABILITIES[platform].episodes ? Promise.resolve(undefined) : iqiyiEpisodes(query, albumId, env, fetcher, cache, loadIqiyi),
  ]);
  const s = tasks[0], e = tasks[1];
  const search = s.status === 'fulfilled' ? s.value as ProviderResult | undefined : undefined;
  const episodes = e.status === 'fulfilled' ? e.value as EpisodesResult | undefined : undefined;
  const searchOperation: Operation = mode === 'episodes' ? omitted('skipped') : search
    ? { status: search.status, count: Math.min(search.results.length, limit), warnings: search.warnings, cached: search.cached, fetched_at: search.fetched_at }
    : { status: 'unavailable', count: 0, warnings: [`search:${s.status === 'rejected' ? code(s.reason) : 'UPSTREAM_ERROR'}`] };
  const episodeOperation: Operation = mode === 'search' ? omitted('skipped') : !CAPABILITIES[platform].episodes ? omitted('unsupported') : episodes
    ? { status: !episodes.ok ? 'unavailable' : episodes.complete ? 'ok' : 'degraded', count: episodes.total, warnings: episodes.warnings, cached: episodes.cached, fetched_at: episodes.fetched_at }
    : e.status === 'rejected' && e.reason instanceof SeriesNotFound
      ? { status: 'empty', count: 0, warnings: [] }
      : { status: 'unavailable', count: 0, warnings: [`episodes:${e.status === 'rejected' ? code(e.reason) : 'UPSTREAM_ERROR'}`] };
  const combined = new Map<string, UnifiedVideo>();
  for (const item of search?.results.slice(0, limit) || []) combined.set(item.url, { ...item, content_type: 'search' });
  for (const item of episodes?.results || []) combined.set(item.url, {
    ...item, score: score(query, episodes!.series.title), content_type: 'episode',
    album_id: episodes!.series.album_id, series_title: episodes!.series.title,
  });
  const results = [...combined.values()].sort((a, b) => {
    if (a.content_type === 'episode' && b.content_type === 'episode') return a.episode_number! - b.episode_number!;
    if (a.content_type !== b.content_type) return a.content_type === 'episode' ? -1 : 1;
    return b.score - a.score || a.url.localeCompare(b.url);
  });
  const active = [searchOperation, episodeOperation].filter(o => !['skipped', 'unsupported'].includes(o.status));
  const failed = active.some(o => ['unavailable', 'degraded', 'stale'].includes(o.status));
  const available = active.some(o => !['unavailable'].includes(o.status));
  const status: OperationStatus = !active.length ? 'unsupported' : !available ? 'unavailable' : failed ? 'degraded' : results.length ? 'ok' : 'empty';
  const warnings = [...new Set(active.flatMap(o => o.warnings))];
  const catalog = episodes ? (({ results: _r, ok: _o, query: _q, platform: _p, ...metadata }) => metadata)(episodes) : undefined;
  return {
    platform, status, count: results.length, available_count: search?.results.length || 0, truncated: (search?.results.length || 0) > limit,
    cached: active.length > 0 && active.every(o => o.cached === true),
    fetched_at: active.find(o => o.fetched_at)?.fetched_at || new Date().toISOString(),
    search_url: PLATFORMS[platform].search + encodeURIComponent(query), warnings,
    operations: { search: searchOperation, episodes: episodeOperation }, catalog, results,
  };
}
