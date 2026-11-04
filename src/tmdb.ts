import { bounded, type CacheStore, type Env, type Fetcher } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const list = (v: unknown): Obj[] => Array.isArray(v) ? v.map(obj) : [];
const titleKey = (v: unknown) => str(v).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const image = (v: unknown, size = 'w500') => /^\/[a-zA-Z0-9_.-]+$/.test(str(v)) ? `https://image.tmdb.org/t/p/${size}${v}` : null;
export interface TmdbMetadata {
  source: 'tmdb'; status: 'matched' | 'not_found' | 'ambiguous' | 'unavailable' | 'skipped';
  id?: number; media_type?: 'movie' | 'tv'; url?: string; season_number?: number;
  episode_status?: 'matched' | 'skipped' | 'unavailable';
}
export interface MediaMetadata { poster_url?: string | null; overview?: string; tmdb?: TmdbMetadata }
export interface EpisodeMetadata { overview?: string; still_url?: string | null; tmdb_episode_name?: string; tmdb_episode_id?: number }

// All state and in-flight deduplication belong to this request, never a Worker global.
export function createTmdbEnricher(env: Env, fetcher: Fetcher, cache?: CacheStore) {
  const enabled = env.TMDB_ENABLED !== 'off' && !!(env.TMDB_READ_ACCESS_TOKEN || env.TMDB_API_KEY);
  const memo = new Map<string, Promise<Obj>>();
  let deadline = 0;
  const budget = bounded(env.TMDB_TIMEOUT_MS, 5000, 250, 15000);
  async function load(path: string, params: Record<string, string> = {}): Promise<Obj> {
    if (!deadline) deadline = Date.now() + budget;
    const u = new URL('https://api.themoviedb.org/3' + path);
    u.searchParams.set('language', 'zh-CN');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const key = new Request('https://tmdb-cache.invalid/v1' + u.pathname + u.search);
    const identity = key.url;
    if (!memo.has(identity)) memo.set(identity, (async () => {
      try { const hit = await cache?.match(key); if (hit) return obj(await hit.json()); } catch { /* cache is optional */ }
      if (Date.now() >= deadline) throw new Error('TMDB_TIMEOUT');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (env.TMDB_READ_ACCESS_TOKEN) headers.Authorization = 'Bearer ' + env.TMDB_READ_ACCESS_TOKEN;
      else u.searchParams.set('api_key', env.TMDB_API_KEY!);
      const response = await fetcher(u.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (!response.ok) throw new Error('TMDB_UNAVAILABLE');
      // Bound decoded response size as well as the network time.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('TMDB_EMPTY');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 2 * 1024 * 1024) throw new Error('TMDB_TOO_LARGE'); chunks.push(r.value); } }
      catch (e) { await reader.cancel(); throw e; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = obj(JSON.parse(new TextDecoder().decode(bytes)));
      if (data.success === false) throw new Error('TMDB_UNAVAILABLE');
      try { await cache?.put(key, Response.json(data, { headers: { 'Cache-Control': 'public, max-age=21600' } })); } catch { /* best effort */ }
      return data;
    })());
    return memo.get(identity)!;
  }
  async function enrich(item: Obj, episodes?: Obj[]) {
    if (!enabled) return;
    const state: TmdbMetadata = { source: 'tmdb', status: 'not_found' };
    item.tmdb = state;
    try {
      const title = str(item.title);
      if (!title) { state.status = 'skipped'; return; }
      const year = str(item.year).match(/\b(?:19|20)\d{2}\b/)?.[0];
      const movie = item.kind === 'movie' || item.category === 'movie' || /电影/.test(str(item.type_name));
      const tv = !movie && (item.kind === 'series' || /电视剧|综艺|动漫|纪录/.test(str(item.type_name)));
      const payload = await load('/search/' + (movie ? 'movie' : tv ? 'tv' : 'multi'), { query: title, include_adult: 'false' });
      // Exact normalized titles only; reject remakes and same-name films rather than taking result #1.
      const candidates = list(payload.results).filter(v => {
        const type = movie ? 'movie' : tv ? 'tv' : v.media_type;
        return (type === 'movie' || type === 'tv') && Number.isSafeInteger(v.id) && Number(v.id) > 0 &&
          [v.title, v.name, v.original_title, v.original_name].some(t => titleKey(t) === titleKey(title)) &&
          (!year || str(type === 'movie' ? v.release_date : v.first_air_date).startsWith(year));
      });
      if (candidates.length !== 1) { state.status = candidates.length ? 'ambiguous' : 'not_found'; return; }
      const match = candidates[0], type = movie ? 'movie' : tv ? 'tv' : match.media_type as 'movie' | 'tv';
      Object.assign(state, { status: 'matched', id: match.id, media_type: type, url: `https://www.themoviedb.org/${type}/${match.id}` });
      item.poster_url ||= image(match.poster_path);
      item.overview ||= str(match.overview);
      if (!episodes?.length || type !== 'tv') return;
      state.episode_status = 'skipped';
      // Flat platform numbering is safe only for a single standard season with the same episode count.
      // Multi-season shows and split versions need an explicit mapping, not an assumed season 1.
      try {
        const details = await load(`/tv/${match.id}`);
        const seasons = list(details.seasons).filter(s => Number(s.season_number) > 0);
        if (seasons.length !== 1) return;
        const main = episodes.filter(e => e.episode_type === 'main');
        const numbers = main.map(e => Number(e.episode_number));
        if (!main.length || numbers.some(n => !Number.isSafeInteger(n) || n < 1) ||
          new Set(numbers).size !== main.length || Number(seasons[0].episode_count) !== main.length || Math.max(...numbers) !== main.length) return;
        const season = await load(`/tv/${match.id}/season/${seasons[0].season_number}`);
        const entries = list(season.episodes);
        if (entries.length !== main.length || new Set(entries.map(e => e.episode_number)).size !== main.length ||
          !numbers.every(n => entries.some(e => e.episode_number === n))) return;
        state.season_number = Number(seasons[0].season_number);
        for (const ep of main) {
          const data = entries.find(e => e.episode_number === ep.episode_number)!;
          ep.overview ||= str(data.overview); ep.still_url ||= image(data.still_path, 'w300');
          ep.tmdb_episode_name = str(data.name); ep.tmdb_episode_id = data.id;
        }
        state.episode_status = 'matched';
      } catch { state.episode_status = 'unavailable'; }
    } catch { state.status = 'unavailable'; }
  }
  return {
    async items(items: object[]) {
      if (!enabled) return;
      let cursor = 0;
      // Limit third-party work per request; untouched tail entries explicitly report skipped.
      const rows = items as Obj[];
      rows.slice(12).forEach(item => { item.tmdb = { source: 'tmdb', status: 'skipped' }; });
      await Promise.all(Array.from({ length: Math.min(3, rows.length, 12) }, async () => {
        while (cursor < Math.min(rows.length, 12)) await enrich(rows[cursor++]);
      }));
    },
    async detail(item: object, episodes: object[]) { await enrich(item as Obj, episodes as Obj[]); },
  };
}
