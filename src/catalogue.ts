import { canonical, score, text } from './normalize';
import {
  classifySeries,
  knownCategory,
  isLongContent,
  recognizeEpisodes,
  aiState,
  type AIState,
  type ContentCategory,
  type EpisodeCandidate,
} from './ai';
import { episodeCandidates } from './episode-evidence';
import { bounded, PLATFORMS, type CacheStore, type Env, type Fetcher, type Platform } from './types';
import {
  iqiyiSearchData,
  json,
  request,
  tencentSearchData,
  mangoSearchData,
  youkuSearchData,
  UpstreamError,
} from './providers';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const num = (x: unknown): number | null =>
  typeof x === 'number' || typeof x === 'string'
    ? /^\d+$/.test(String(x)) && Number(x) > 0 && Number(x) <= 10000
      ? Number(x)
      : null
    : null;
const string = (x: unknown): string =>
  typeof x === 'string' ? x : typeof x === 'number' && Number.isSafeInteger(x) ? String(x) : '';
function objects(value: unknown): Obj[] {
  const out: Obj[] = [];
  function walk(x: unknown, depth: number) {
    if (depth > 24 || out.length > 20000) return;
    if (Array.isArray(x)) {
      for (const v of x) walk(v, depth + 1);
    } else if (x && typeof x === 'object') {
      const o = obj(x);
      out.push(o);
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  }
  walk(value, 0);
  return out;
}
export function embeddedJson(html: string, name: string): unknown {
  const start = html.indexOf(name);
  if (start < 0) throw new UpstreamError('SCHEMA_OR_CHALLENGE');
  const equal = html.indexOf('=', start + name.length),
    open = html.indexOf('{', equal + 1);
  if (equal < 0 || open < 0) throw new UpstreamError('SCHEMA_CHANGED');
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return json(html.slice(open, i + 1));
  }
  throw new UpstreamError('INVALID_EMBEDDED_JSON');
}
export interface SeriesSummary {
  platform: Platform;
  platform_name: string;
  id: string;
  title: string;
  year: string;
  kind: 'series' | 'movie' | 'collection';
  type_name: string;
  category?: ContentCategory;
  total_episodes: number | null;
  url: string;
  detail_url: string;
  score: number;
  content_type: 'series';
}
export interface CatalogueEpisode {
  episode_number: number | null;
  title: string;
  url: string;
  platform: Platform;
  episode_type: 'main' | 'extra' | 'preview';
  recognition?: 'ai' | 'structured';
}
interface Seed {
  series: SeriesSummary;
  preview: CatalogueEpisode[];
  preview_verified?: boolean;
  candidates?: EpisodeCandidate[];
}
interface Discovery {
  ai: AIState;
  excluded_ids: string[];
  records: Seed[];
  warnings: string[];
  fetched_at: string;
  cached: boolean;
}
export interface CatalogueResult {
  ok: boolean;
  platform: Platform;
  series: SeriesSummary;
  total: number;
  expected_total: number | null;
  update_notice?: string;
  main_total: number;
  extra_total: number;
  complete: boolean;
  partial: boolean;
  missing_episode_numbers: number[];
  episodes: CatalogueEpisode[];
  previews: CatalogueEpisode[];
  unavailable_episode_numbers: number[];
  ai: AIState;
  warnings: string[];
  cached: boolean;
  fetched_at: string;
  source: string;
}
export function validSeriesId(platform: Platform, id: string): boolean {
  return {
    iqiyi: /^\d{1,20}$/,
    tencent: /^[a-z\d]{5,32}$/i,
    youku: /^[a-z\d]{8,40}$/i,
    mango: /^\d{1,12}-\d{1,16}$/,
    bilibili: /^ss\d{1,16}$/,
  }[platform].test(id);
}
function summary(
  platform: Platform,
  id: string,
  title: unknown,
  query: string,
  expected: unknown,
  year: unknown,
  url: string,
  typeName = '',
  kind: SeriesSummary['kind'] = 'series',
): SeriesSummary {
  return {
    platform,
    platform_name: PLATFORMS[platform].name,
    id,
    title: text(title) || `${PLATFORMS[platform].name} ${id}`,
    year: text(string(year)),
    kind,
    type_name: text(typeName),
    total_episodes: num(expected),
    url,
    detail_url: `/v1/${platform}/series/${encodeURIComponent(id)}?q=${encodeURIComponent(query.slice(0, 80))}`,
    score: score(query, text(title)),
    content_type: 'series',
  };
}
function episode(
  platform: Platform,
  number: unknown,
  title: unknown,
  url: unknown,
  extra = false,
): CatalogueEpisode | undefined {
  const c = canonical(url, platform),
    t = text(title);
  if (!c || !t) return;
  return {
    platform,
    episode_number: num(number),
    title: t,
    url: c.url,
    episode_type: extra ? 'extra' : 'main',
  };
}
function redirectTarget(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    const u = new URL(raw);
    return u.hostname === 'v.qq.com' && u.pathname === '/search_redirect.html'
      ? u.searchParams.get('url') || ''
      : raw;
  } catch {
    return raw;
  }
}
function fromTencent(payload: unknown, platform: Platform, query: string): Seed[] {
  const root = obj(payload),
    data = obj(root.data);
  if (
    (root.ret !== undefined && Number(root.ret) !== 0) ||
    !data.normalList ||
    (data.errcode !== undefined && Number(data.errcode) !== 0)
  )
    throw new UpstreamError('SEARCH_API_REJECTED');
  const out: Seed[] = [];
  for (const o of objects(data)) {
    const v = obj(o.videoInfo);
    if (!v.title) continue;
    for (const rawSite of [...arr(v.episodeSites), ...arr(v.playSites)]) {
      const site = obj(rawSite),
        entries = arr(site.episodeInfoList);
      for (const raw of entries) {
        const e = obj(raw),
          target = redirectTarget(e.url),
          c = canonical(target, platform);
        if (!c) continue;
        const id =
          platform === 'tencent'
            ? c.url.match(/\/cover\/([a-z\d]+)/i)?.[1]
            : platform === 'mango'
              ? c.url
                  .match(/\/b\/(\d+)\/(\d+)/)
                  ?.slice(1)
                  .join('-')
              : platform === 'youku'
                ? new URL(c.url).searchParams.get('s')
                : platform === 'bilibili'
                  ? c.url.match(/\/play\/(ss\d+)/)?.[1]
                  : undefined;
        if (!id || !validSeriesId(platform, id)) continue;
        const title = text(v.title),
          kind = Number(v.videoType) === 1 ? 'movie' : 'series';
        const link = platform === 'tencent' ? `https://v.qq.com/x/cover/${id}.html` : c.url;
        const previews = entries.flatMap((raw) => {
          const p = obj(raw),
            ep = episode(platform, p.title, `${title} ${text(p.title)}`, redirectTarget(p.url));
          return ep ? [ep] : [];
        });
        out.push({
          series: summary(
            platform,
            id,
            title,
            query,
            site.totalEpisode,
            string(v.year),
            link,
            text(v.typeName),
            kind,
          ),
          preview: previews,
        });
        break;
      }
    }
  }
  return out;
}
function youkuEpisode(v: Obj, id: string, title: string): CatalogueEpisode | undefined {
  const vid = string(v.videoId),
    order = num(v.orderId);
  const extra =
    /^(番外|彩蛋|特辑|加更)/.test(text(v.displayName)) || /^(番外|彩蛋|特辑|加更)/.test(text(v.chapterName));
  if (
    !/^[a-z\d=]+$/i.test(vid) ||
    (!order && !extra) ||
    (v.showId && string(v.showId) !== id) ||
    (v.chapterName && v.chapterName !== '正片' && !extra) ||
    Number(v.peripheryVideoType || 0) !== 0 ||
    v.isTrailer === true ||
    v.isTrailer === 1
  )
    return;
  const action = string(obj(v.action).value);
  if (action) {
    try {
      const u = new URL(action),
        show = u.searchParams.get('showid'),
        video = u.searchParams.get('vid');
      if ((show && show !== id) || (video && video !== vid)) return;
    } catch {
      return;
    }
  }
  return episode(
    'youku',
    extra ? null : order,
    v.title || `${title} 第${order}集`,
    `https://v.youku.com/v_show/id_${vid}.html`,
    extra,
  );
}
function fromYouku(payload: unknown, query: string): Seed[] {
  const out: Seed[] = [];
  const groups = obj(obj(payload).data).nodes;
  if (!Array.isArray(groups)) throw new UpstreamError('SCHEMA_CHANGED');
  for (const group of groups) {
    const nodes = objects(group),
      show = nodes.find((o) => o.showId && o.episodeTotal && o.tempTitle);
    if (!show) continue;
    if (show.isYouku === 0 || show.hasYouku === 0) continue;
    const id = string(show.showId);
    if (!validSeriesId('youku', id)) continue;
    const title = text(show.tempTitle || obj(show.titleDTO).displayName);
    const eps = nodes.flatMap((v) => {
      const ep = youkuEpisode(v, id, title);
      return ep ? [ep] : [];
    });
    const feature = text(obj(show.featureDTO).text || show.feature);
    out.push({
      series: summary(
        'youku',
        id,
        title,
        query,
        show.episodeTotal,
        feature.match(/\b(?:19|20)\d{2}\b/)?.[0],
        `https://v.youku.com/video?s=${id}`,
        feature,
      ),
      preview: eps,
      preview_verified: true,
      candidates: episodeCandidates(group, 'youku', id, 'youku_search'),
    });
  }
  return out;
}
function fromBilibili(rows: unknown, query: string): Seed[] {
  return arr(rows).flatMap((raw) => {
    const v = obj(raw),
      id = `ss${string(v.season_id)}`;
    if (!validSeriesId('bilibili', id)) return [];
    return [
      {
        series: summary(
          'bilibili',
          id,
          v.title,
          query,
          v.ep_size,
          '',
          `https://www.bilibili.com/bangumi/play/${id}`,
          text(v.season_type_name),
        ),
        preview: [],
      },
    ];
  });
}
async function freshDiscovery(
  platform: Platform,
  query: string,
  env: Env,
  fetcher: Fetcher,
): Promise<{ records: Seed[]; warnings: string[]; ai: AIState; excluded_ids: string[] }> {
  const q = encodeURIComponent(query),
    warnings: string[] = [];
  let records: Seed[] = [];
  if (platform === 'iqiyi') {
    const d = obj(await iqiyiSearchData(query, env, fetcher)),
      templates = obj(d.data).templates;
    if (!Array.isArray(templates)) throw new UpstreamError('SCHEMA_CHANGED');
    for (const raw of templates) {
      const a = obj(obj(raw).albumInfo),
        id = string(a.qipuId);
      if (
        !['1', '2', '3', '4', '6'].includes(String(a.channel).split(',').at(-1) || '') ||
        (a.siteId && a.siteId !== 'iqiyi') ||
        !validSeriesId(platform, id)
      )
        continue;
      const c = canonical(a.pageUrl, platform);
      if (!c) continue;
      const previews = arr(a.videos).flatMap((v) => {
        const o = obj(v),
          e = episode(platform, o.number, o.title, o.pageUrl);
        return e ? [e] : [];
      });
      records.push({
        series: summary(
          platform,
          id,
          a.title,
          query,
          String(a.channel).endsWith(',1') ? 1 : a.totalNumber,
          obj(a.year).value,
          c.url,
          String(a.channel).split(',')[0],
          String(a.channel).endsWith(',1') ? 'movie' : 'series',
        ),
        preview: previews,
        candidates: episodeCandidates(a, platform, id, 'iqiyi_search'),
      });
    }
  } else if (platform === 'tencent')
    records = fromTencent(await tencentSearchData(query, env, fetcher), platform, query);
  else if (platform === 'youku') {
    try {
      records = fromYouku(
        embeddedJson(
          await request(`https://so.youku.com/search_video/q_${q}`, env, fetcher, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
          }),
          'window.__INITIAL_DATA__',
        ),
        query,
      );
    } catch (e) {
      warnings.push(`web:${e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR'}`);
      records = fromYouku(await youkuSearchData(query, env, fetcher), query);
      warnings.push('DISCOVERY_FROM_YOUKU_API');
    }
  } else if (platform === 'bilibili') {
    const pages = await Promise.allSettled(
      ['media_bangumi', 'media_ft'].map(async (type) => {
        const d = obj(
          json(
            await request(
              `https://api.bilibili.com/x/web-interface/search/type?search_type=${type}&keyword=${q}&page=1`,
              env,
              fetcher,
              { headers: { Referer: 'https://www.bilibili.com/' } },
            ),
          ),
        );
        if (d.code !== 0) throw new UpstreamError(`API_${Number(d.code) || 'ERROR'}`);
        const data = obj(d.data);
        if (!Array.isArray(data.result) && Number(data.numResults) !== 0)
          throw new UpstreamError('SCHEMA_CHANGED');
        return fromBilibili(data.result, query);
      }),
    );
    for (const p of pages)
      if (p.status === 'fulfilled') records.push(...p.value);
      else warnings.push(p.reason instanceof UpstreamError ? p.reason.message : 'UPSTREAM_ERROR');
    if (!records.length && warnings.length) {
      // The public all-search route can remain available when category endpoints are restricted.
      const r = obj(
        json(
          await request(
            `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${q}&page=1`,
            env,
            fetcher,
            { headers: { Referer: 'https://www.bilibili.com/' } },
          ),
        ),
      );
      if (r.code !== 0 || !Array.isArray(obj(r.data).result)) throw new UpstreamError(warnings[0]);
      for (const raw of arr(obj(r.data).result)) {
        const group = obj(raw);
        if (['media_bangumi', 'media_ft'].includes(string(group.result_type)))
          records.push(...fromBilibili(group.data, query));
      }
      warnings.push('DISCOVERY_FROM_BILIBILI_ALL');
    }
  } else {
    const d = await mangoSearchData(query, env, fetcher);
    for (const raw of arr(d.data.contents)) {
      const card = obj(raw),
        data = obj(card.data);
      // Native video cards are clips, even when their tag says TV/variety. Only program cards are albums.
      if (!['program', 'movie', 'album', 'show'].includes(string(card.type))) continue;
      const years = arr(data.yearList).length ? arr(data.yearList) : [data];
      for (const rawYear of years) {
        const v = obj(rawYear),
          title = text(v.title || data.title);
        const type = arr(v.desc)
          .map((x) => obj(x))
          .filter((x) => x.label === '类型')
          .map((x) => text(x.text))
          .join(' ');
        for (const rawSite of arr(v.sourceList)) {
          const site = obj(rawSite);
          if (site.source && site.source !== 'imgo') continue;
          const video = arr(site.videoList)
            .map((x) => obj(x))
            .find((x) => canonical(x.url, platform));
          const c = canonical(video?.url || site.playUrl, platform);
          if (!c || !title) continue;
          const parts = c.url.match(/\/b\/(\d+)\/(\d+)/);
          if (!parts) continue;
          const startVid = /^\d+$/.test(string(site.vid)) ? string(site.vid) : parts[2];
          const id = parts[1] + '-' + startVid;
          const primary = `https://www.mgtv.com/b/${parts[1]}/${startVid}.html`;
          records.push({
            series: summary(
              platform,
              id,
              title,
              query,
              v.totalNumber || v.total,
              v.year,
              primary,
              type,
              /电影/.test(type) ? 'movie' : 'series',
            ),
            preview: [],
          });
        }
      }
    }
  }
  const unique = new Map<string, Seed>();
  for (const r of records)
    if (r.series.score >= 0.12) {
      const key = platform === 'mango' ? r.series.id.split('-')[0] : r.series.id;
      if (!unique.has(key)) unique.set(key, r);
    }
  const candidates = [...unique.values()].sort((a, b) => b.series.score - a.series.score).slice(0, 50);
  const classified = await classifySeries(
    candidates.map((v) => v.series),
    env,
    fetcher,
  );
  records = candidates.filter((v) => isLongContent(classified.categories.get(v.series.id)!));
  for (const v of records) {
    v.series.category = classified.categories.get(v.series.id);
    if (v.series.category === 'movie') v.series.kind = 'movie';
  }
  warnings.push(...classified.ai.warnings);
  return {
    records,
    warnings,
    ai: classified.ai,
    excluded_ids: candidates.filter((v) => !records.includes(v)).map((v) => v.series.id),
  };
}
async function discovery(
  platform: Platform,
  query: string,
  env: Env,
  fetcher: Fetcher,
  cache?: CacheStore,
): Promise<Discovery> {
  const key = new Request(
      `https://cn-video-search.internal/series/long-ai/v4/${platform}?q=${encodeURIComponent(query)}&ai=${encodeURIComponent(env.DEEPSEEK_API_KEY ? env.DEEPSEEK_MODEL || 'deepseek-flash' : 'off')}`,
    ),
    ttl = bounded(env.CACHE_TTL_SECONDS, 300, 30, 3600);
  if (cache)
    try {
      const r = await cache.match(key);
      if (r) {
        const d = (await r.json()) as Discovery;
        const age = Date.now() - Date.parse(d.fetched_at);
        if (age >= 0 && age < ttl * 1000) return { ...d, cached: true };
      }
    } catch {}
  const d = {
    ...(await freshDiscovery(platform, query, env, fetcher)),
    fetched_at: new Date().toISOString(),
    cached: false,
  };
  if (cache)
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(d), { headers: { 'Cache-Control': `public, max-age=${ttl}` } }),
      );
    } catch {}
  return d;
}
export async function searchSeries(
  platform: Platform,
  query: string,
  limit: number,
  env: Env,
  fetcher: Fetcher,
  cache?: CacheStore,
) {
  try {
    const d = await discovery(platform, query, env, fetcher, cache);
    return {
      platform,
      status: d.warnings.some((w) => !w.startsWith('DISCOVERY_'))
        ? 'degraded'
        : d.records.length
          ? 'ok'
          : 'empty',
      total: d.records.length,
      count: Math.min(limit, d.records.length),
      truncated: d.records.length > limit,
      results: d.records.slice(0, limit).map((r) => r.series),
      warnings: d.warnings,
      cached: d.cached,
      ai: d.ai,
      fetched_at: d.fetched_at,
    };
  } catch (e) {
    return {
      platform,
      status: 'unavailable',
      total: 0,
      count: 0,
      truncated: false,
      results: [] as SeriesSummary[],
      ai: aiState(env, 'not_needed'),
      warnings: [e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR'],
      cached: false,
      fetched_at: new Date().toISOString(),
    };
  }
}

export async function seriesCatalogue(
  platform: Platform,
  id: string,
  query: string,
  env: Env,
  fetcher: Fetcher,
  cache?: CacheStore,
): Promise<CatalogueResult> {
  const key = new Request(
      `https://cn-video-search.internal/catalogue/long-ai/v5/${platform}/${id}?q=${encodeURIComponent(query)}&ai=${encodeURIComponent(env.DEEPSEEK_API_KEY ? env.DEEPSEEK_MODEL || 'deepseek-flash' : 'off')}`,
    ),
    ttl = bounded(env.CACHE_TTL_SECONDS, 300, 30, 3600);
  if (cache)
    try {
      const r = await cache.match(key);
      if (r) {
        const d = (await r.json()) as CatalogueResult;
        if (Date.now() >= Date.parse(d.fetched_at) && Date.now() - Date.parse(d.fetched_at) < ttl * 1000)
          return { ...d, cached: true };
      }
    } catch {}
  let seed: Seed | undefined;
  let excluded = false;
  const warnings: string[] = [];
  if (query)
    try {
      const d = await discovery(platform, query, env, fetcher, cache);
      seed = d.records.find((r) => r.series.id === id);
      excluded = d.excluded_ids.includes(id);
    } catch (e) {
      warnings.push(`discovery:${e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR'}`);
    }
  let meta = seed?.series || summary(platform, id, '', query, null, '', '', platform);
  let expected = meta.total_episodes,
    verified = false,
    allPages = true;
  let source: string = platform;
  let updateNotice = '';
  let episodes: CatalogueEpisode[] = [];
  let candidates: EpisodeCandidate[] = seed?.candidates || [];
  let ai = aiState(env);
  const collect = (raw: unknown, source: string) => {
    candidates.push(...episodeCandidates(raw, platform, id, source));
  };
  try {
    if (excluded) throw new UpstreamError('CONTENT_TYPE_EXCLUDED');
    if (platform === 'iqiyi' && meta.kind === 'movie' && seed) {
      const e = episode(platform, 1, meta.title, meta.url);
      if (e) episodes.push(e);
      expected = 1;
      verified = true;
    } else if (platform === 'iqiyi') {
      const first = obj(
        json(
          await request(
            `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${id}&page=1&size=100`,
            env,
            fetcher,
          ),
        ),
      );
      if (first.code !== 'A00000' || string(obj(first.data).albumId) !== id)
        throw new UpstreamError('ALBUM_SCHEMA_CHANGED');
      const data = obj(first.data),
        total = num(data.total);
      if (!Array.isArray(data.epsodelist)) throw new UpstreamError('ALBUM_SCHEMA_CHANGED');
      if (expected && total && expected !== total) warnings.push('EPISODE_TOTAL_MISMATCH');
      expected = total || expected;
      const pages = [data];
      const count = Math.min(5, Math.ceil((total || 100) / 100));
      const rest = await Promise.allSettled(
        Array.from({ length: count - 1 }, async (_, i) => {
          const r = obj(
            json(
              await request(
                `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${id}&page=${i + 2}&size=100`,
                env,
                fetcher,
              ),
            ),
          );
          if (r.code !== 'A00000' || string(obj(r.data).albumId) !== id)
            throw new UpstreamError('ALBUM_SCHEMA_CHANGED');
          return obj(r.data);
        }),
      );
      for (const p of rest)
        if (p.status === 'fulfilled') pages.push(p.value);
        else {
          allPages = false;
          warnings.push('CATALOGUE_PAGE_FAILED');
        }
      if ((total || 0) > 500 || pages.at(-1)?.hasMore === true) allPages = false;
      for (const page of pages) collect(page, 'iqiyi_album');
      for (const page of pages)
        for (const raw of arr(page.epsodelist)) {
          const v = obj(raw);
          if ((v.contentType !== undefined && Number(v.contentType) !== 1) || v.effective === false) continue;
          const e = episode(platform, v.order, v.name, v.playUrl);
          if (e) episodes.push(e);
        }
      verified = true;
    } else if (platform === 'tencent') {
      let context: unknown = undefined;
      for (let page = 0; page < 5; page++) {
        const r = obj(
          json(
            await request(
              'https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?vplatform=2&vversion_name=8.2.96',
              env,
              fetcher,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Referer: 'https://m.v.qq.com/' },
                body: JSON.stringify({
                  page_params: {
                    req_from: 'web_mobile',
                    page_id: 'vsite_episode_list',
                    page_type: 'detail_operation',
                    id_type: '1',
                    page_size: '100',
                    cid: id,
                    detail_page_type: '1',
                    ...(context ? { page_context: context } : {}),
                  },
                  has_cache: 1,
                }),
              },
            ),
          ),
        );
        const data = obj(r.data);
        if (
          Number(r.ret) !== 0 ||
          typeof data.has_next_page !== 'boolean' ||
          !Array.isArray(data.module_list_datas)
        )
          throw new UpstreamError('CATALOGUE_SCHEMA_CHANGED');
        collect(data, 'tencent_catalogue');
        for (const v of objects(data)) {
          const p = obj(v.item_params);
          if (p.cid !== id || !p.vid || !/^[a-z\d]+$/i.test(string(p.vid))) continue;
          const n = num(p.title) || num(p.c_title_output),
            label = text(p.c_title_output || p.title);
          if (!label) continue;
          const extra = meta.kind !== 'movie' && !n;
          const e = episode(
            platform,
            n,
            n ? `${seed?.series.title || '第'} ${n}集` : label,
            `https://v.qq.com/x/cover/${id}/${p.vid}.html`,
            extra,
          );
          if (e) episodes.push(e);
        }
        verified = true;
        if (data.has_next_page !== true) break;
        context = data.next_page_context;
        if (!context || page === 4) {
          allPages = false;
          break;
        }
      }
      if (!expected && allPages) expected = new Set(episodes.map((e) => e.url)).size || null;
    } else if (platform === 'youku') {
      // The SSR payload scopes each complete episode block to its own showId; never combine sibling shows.
      if (!seed && query)
        seed = (await discovery(platform, query, env, fetcher)).records.find((r) => r.series.id === id);
      if (!seed) throw new UpstreamError(query ? 'SERIES_NOT_FOUND' : 'DETAIL_QUERY_REQUIRED');
      meta = seed.series;
      expected = meta.total_episodes;
      episodes = seed.preview;
      verified = seed.preview_verified === true;
      source = 'youku_ssr_catalogue';
      if (new Set(episodes.filter((e) => e.episode_type === 'main').map((e) => e.url)).size !== expected) {
        const data = obj(
          json(
            await request(
              `https://search.youku.com/api/search?appScene=show_episode&appCaller=h5&showIds=${id}&keyword=${encodeURIComponent(meta.title)}`,
              env,
              fetcher,
            ),
          ),
        );
        if (
          data.message !== 'success' ||
          string(data.showId) !== id ||
          Number(data.isYouku) !== 1 ||
          !Array.isArray(data.serisesList)
        )
          throw new UpstreamError('YOUKU_CATALOGUE_SCHEMA_CHANGED');
        collect(data, 'youku_episode_api');
        episodes = data.serisesList.flatMap((raw) => {
          const item = obj(raw);
          const e = youkuEpisode(
            meta.kind === 'movie' && !item.orderId ? { ...item, orderId: 1 } : item,
            id,
            meta.title,
          );
          return e ? [e] : [];
        });
        updateNotice = text(data.updateNotice);
        const released = updateNotice.match(/更新至\s*(\d+)\s*[/／]\s*(\d+)\s*[集期]/);
        if (released && num(released[1]) && num(released[2]) && Number(released[1]) <= Number(released[2])) {
          if (expected !== null && Number(released[2]) !== expected) warnings.push('UPDATE_TOTAL_MISMATCH');
          else {
            // The planned finale is not a missing episode. Preserve genuine gaps within the published range.
            const available = Math.max(
              Number(released[1]),
              ...episodes.filter((e) => e.episode_type === 'main').map((e) => e.episode_number || 0),
            );
            if (available <= Number(released[2])) expected = available;
          }
        }
        if (expected !== null)
          expected += new Set(episodes.filter((e) => e.episode_type === 'extra').map((e) => e.url)).size;
        verified = true;
        source = 'youku_episode_api';
      } else if (expected !== null)
        expected += new Set(episodes.filter((e) => e.episode_type === 'extra').map((e) => e.url)).size;
    } else if (platform === 'bilibili') {
      let data: Obj;
      try {
        const r = obj(
          json(
            await request(
              `https://api.bilibili.com/pgc/view/web/season?season_id=${id.slice(2)}`,
              env,
              fetcher,
              { headers: { Referer: 'https://www.bilibili.com/' } },
            ),
          ),
        );
        data = obj(r.result);
        if (r.code !== 0 || `ss${string(data.season_id)}` !== id || !Array.isArray(data.episodes))
          throw new UpstreamError('SEASON_SCHEMA_CHANGED');
      } catch (e) {
        warnings.push(`season:${e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR'}`);
        let metadata: Obj = {};
        if (!seed) {
          const html = await request(`https://www.bilibili.com/bangumi/play/${id}`, env, fetcher, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const raw = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
          if (!raw) throw new UpstreamError('SEASON_SCHEMA_CHANGED');
          const candidates = objects(json(raw));
          metadata = candidates.find((v) => `ss${string(v.season_id)}` === id && v.total && v.positive) || {};
          if (!metadata.season_id) throw new UpstreamError('SEASON_ID_MISMATCH');
        }
        const r = obj(
          json(
            await request(
              `https://api.bilibili.com/pgc/web/season/section?season_id=${id.slice(2)}`,
              env,
              fetcher,
              { headers: { Referer: 'https://www.bilibili.com/' } },
            ),
          ),
        );
        const main = obj(obj(r.result).main_section);
        if (
          r.code !== 0 ||
          !Array.isArray(main.episodes) ||
          (obj(metadata.positive).id && main.id !== obj(metadata.positive).id)
        )
          throw new UpstreamError('SECTION_SCHEMA_CHANGED');
        data = {
          season_id: id.slice(2),
          title: metadata.title || meta.title,
          total: metadata.total || expected,
          episodes: arr(main.episodes).map((v) => ({ ...obj(v), section_type: 0, link: obj(v).share_url })),
        };
        source = 'bilibili_section';
      }
      meta = {
        ...meta,
        title: text(data.title) || meta.title,
        url: `https://www.bilibili.com/bangumi/play/${id}`,
      };
      collect(data, 'bilibili_season');
      expected = num(data.total) || expected;
      for (const raw of arr(data.episodes)) {
        const v = obj(raw);
        if (
          (v.section_type !== undefined && v.section_type !== 0) ||
          /预告|PV|花絮/.test(text(v.badge) + ' ' + text(v.share_copy))
        )
          continue;
        const n = meta.kind === 'movie' ? 1 : num(v.title);
        if (!n) continue;
        const e = episode(platform, n, `${meta.title} 第${n}集 ${text(v.long_title)}`, v.link);
        if (e) episodes.push(e);
      }
      verified = true;
    } else {
      const [cid, vid] = id.split('-');
      let totalPages = 1,
        totalItems: number | null = null;
      for (let page = 0; page < Math.min(totalPages, 10); page++) {
        const r = obj(
          json(
            await request(
              `https://pcweb.api.mgtv.com/episode/list?video_id=${vid}&page=${page + 1}&size=100`,
              env,
              fetcher,
              { headers: { Referer: 'https://www.mgtv.com/' } },
            ),
          ),
        );
        const data = obj(r.data);
        if (Number(r.code) !== 200 || !Array.isArray(data.list))
          throw new UpstreamError('CATALOGUE_SCHEMA_CHANGED');
        totalPages = num(data.total_page) || 1;
        totalItems = num(data.count) || num(data.total) || totalItems;
        collect(data, 'mango_catalogue');
        for (const raw of data.list) {
          const v = obj(raw),
            c = canonical(v.url, platform);
          if (!c || !c.url.includes(`/b/${cid}/`)) continue;
          const title = text(v.t2 || v.t3 || v.t1),
            extra = /加更|直拍|纯享|花絮|预告|超前营业|特别企划|陪看|Reaction/.test(title);
          const n = title.match(/第\s*(\d+)\s*[集期]/)?.[1] || (/^\d+$/.test(title) ? title : null);
          const e = episode(platform, n, title, c.url, extra);
          if (e) episodes.push(e);
        }
      }
      if (totalPages > 10) allPages = false;
      // This endpoint counts multiple editions and extras. Keep their labels and never invent sequential numbers.
      expected = totalItems;
      verified = true;
      source = 'mgtv_episode_list';
    }
  } catch (e) {
    allPages = false;
    warnings.push(e instanceof UpstreamError ? e.message : 'UPSTREAM_ERROR');
    if (!episodes.length && seed?.preview.length) {
      episodes = seed.preview;
      warnings.push('SEARCH_PREVIEW_FALLBACK');
    }
  }
  // Preserve source-labelled previews, then ask AI only about ambiguous/unparsed candidates.
  const candidateMap = new Map<string, EpisodeCandidate>();
  for (const c of candidates) {
    const old = candidateMap.get(c.url);
    if (!old) candidateMap.set(c.url, { ...c });
    else {
      old.preview ||= c.preview;
      old.extra ||= c.extra;
      old.number_hint ??= c.number_hint;
    }
  }
  candidates = [...candidateMap.values()].map((c, i) => ({ ...c, ref: `c${i + 1}` }));
  const previews: CatalogueEpisode[] = candidates
    .filter((c) => c.preview)
    .map((c) => ({
      platform,
      url: c.url,
      title: c.title,
      episode_number: c.number_hint,
      episode_type: 'preview' as const,
      recognition: 'structured' as const,
    }));
  const previewUrls = new Set(previews.map((e) => e.url));
  episodes = episodes.filter((e) => !previewUrls.has(e.url));
  const unknown = candidates.filter((c) => !episodes.some((e) => e.url === c.url));
  const mainNumbers = new Set(episodes.filter((e) => e.episode_type === 'main').map((e) => e.episode_number));
  const hasGap =
    expected !== null &&
    Array.from({ length: Math.min(expected, 10000) }, (_, i) => i + 1).some((n) => !mainNumbers.has(n));
  if (unknown.length && (hasGap || unknown.some((c) => !c.preview && !c.extra))) {
    const recognized = await recognizeEpisodes(meta, unknown, episodes, expected, env, fetcher);
    ai = recognized.ai;
    warnings.push(...ai.warnings);
    const oldUrls = new Set([...episodes, ...previews].map((e) => e.url));
    ai.recovered = recognized.episodes.filter((e) => !oldUrls.has(e.url)).length;
    for (const e of recognized.episodes) {
      if (e.episode_type === 'preview') {
        if (!previews.some((v) => v.url === e.url)) previews.push({ ...e, recognition: 'ai' });
      } else episodes.push(e);
    }
  }
  const seen = new Map<string, CatalogueEpisode>();
  for (const e of episodes) seen.set(e.url, e);
  episodes = [...seen.values()];
  episodes.sort(
    (a, b) =>
      Number(a.episode_type === 'extra') - Number(b.episode_type === 'extra') ||
      (a.episode_number ?? 100000) - (b.episode_number ?? 100000),
  );
  const main = episodes.filter((e) => e.episode_type === 'main'),
    numbers = new Set(main.map((e) => e.episode_number).filter((n): n is number => n !== null));
  const numeric = meta.kind !== 'movie' && platform !== 'mango';
  // Tencent search totals include extras. When entries are missing, only report provable gaps,
  // rather than inventing trailing episode numbers from an ambiguous total.
  const numberedExpected =
    platform === 'tencent' && episodes.length !== expected
      ? Math.max(0, ...numbers)
      : expected === null
        ? null
        : expected - (episodes.length - main.length);
  const gaps =
    numberedExpected && numeric
      ? Array.from({ length: numberedExpected }, (_, i) => i + 1).filter((n) => !numbers.has(n))
      : [];
  const unavailable = gaps.filter((n) => previews.some((e) => e.episode_number === n));
  const missing = gaps.filter((n) => !unavailable.includes(n));
  const conflicts = numeric && main.length !== numbers.size;
  if (conflicts) warnings.push('CONFLICTING_EPISODE_NUMBERS');
  const complete =
    verified &&
    allPages &&
    expected !== null &&
    episodes.length === expected &&
    !missing.length &&
    !unavailable.length &&
    !conflicts &&
    !warnings.includes('EPISODE_TOTAL_MISMATCH') &&
    !warnings.includes('UPDATE_TOTAL_MISMATCH');
  if (unavailable.length) warnings.push('EPISODE_MAIN_UNAVAILABLE');
  if (!complete) warnings.push('EPISODE_LIST_INCOMPLETE');
  const result: CatalogueResult = {
    ok: episodes.length > 0,
    platform,
    series: meta,
    total: episodes.length,
    main_total: main.length,
    extra_total: episodes.length - main.length,
    expected_total: expected,
    ...(updateNotice ? { update_notice: updateNotice } : {}),
    complete,
    partial: !complete,
    missing_episode_numbers: missing,
    episodes,
    previews,
    unavailable_episode_numbers: unavailable,
    ai,
    warnings: [...new Set(warnings)],
    cached: false,
    fetched_at: new Date().toISOString(),
    source,
  };
  if (complete && cache)
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(result), { headers: { 'Cache-Control': `public, max-age=${ttl}` } }),
      );
    } catch {}
  return result;
}
