import type { EpisodeMetadata, MediaMetadata } from './tmdb';
import { DOMParser } from 'linkedom';
import { canonical, text, score } from './normalize';
import { request, UpstreamError } from './providers';
import type { Env, Fetcher, Platform } from './types';

import { RESOURCE_SOURCES, type ResourceSource, type ResourceSourceConfig } from './resource-config';
export { RESOURCE_SOURCES } from './resource-config';
export type { ResourceSource } from './resource-config';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const integer = (v: unknown): number | null => /^\d+$/.test(str(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
export const validResourceId = (id: string) => /^[a-z\d_-]{1,80}$/i.test(id);
const platformNames: Record<string, Platform> = { qq: 'tencent', qiyi: 'iqiyi', iqiyi: 'iqiyi', youku: 'youku', mgtv: 'mango', bilibili: 'bilibili' };

export function resourceLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const u = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    // Do not publish clickable local-network URLs from untrusted upstream data.
    const h = u.hostname.toLowerCase();
    if (h.includes(':') || !h.includes('.') || h.endsWith('.local') || h.endsWith('.localhost') ||
      /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return null;
    return u.href;
  } catch { return null; }
}

interface ResourceEpisode extends EpisodeMetadata {
  title: string;
  url: string;
  episode_number: number | null;
  episode_type: 'main' | 'preview';
  platform: Platform | null;
  link_type: 'official_page' | 'media' | 'external_page';
  playback_verified: false;
}
export interface ResourceItem extends MediaMetadata {
  id: string;
  title: string;
  source_id: ResourceSource;
  source_name: string;
  source: 'third_party';
  content_type: 'resource';
  year: string;
  type_name: string;
  remarks: string;
  updated_at: string;
  detail_url: string;
  play_sources: string[];
  lines: { name: string; platform: Platform | null; episodes: ResourceEpisode[]; previews: ResourceEpisode[] }[];
}

function parseItem(raw: unknown, source: ResourceSource, definition?: ResourceSourceConfig): ResourceItem | null {
  const v = obj(raw), id = str(v.vod_id), title = text(v.vod_name);
  if (!validResourceId(id) || !title) return null;
  const names = str(v.vod_play_from).split(/\$\$\$|,/).map(s => s.trim()).filter(Boolean);
  const groups = str(v.vod_play_url).split('$$$');
  const lines = groups.flatMap((group, i) => {
    if (!group.trim()) return [];
    const name = names[i] || `line${i + 1}`, sourcePlatform = platformNames[name.toLowerCase()] || null;
    const seen = new Set<string>(), entries: ResourceEpisode[] = [];
    const rawEpisodes = group.split('#');
    if (rawEpisodes.length > 2000) throw new UpstreamError('RESOURCE_TOO_MANY_EPISODES');
    for (const rawEpisode of rawEpisodes) {
      const cut = rawEpisode.indexOf('$'), label = cut < 0 ? '' : text(rawEpisode.slice(0, cut));
      const url = resourceLink(cut < 0 ? rawEpisode.trim() : rawEpisode.slice(cut + 1).trim());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const official = (['tencent', 'iqiyi', 'youku', 'mango', 'bilibili'] as Platform[])
        .map(platform => ({ platform, link: canonical(url, platform) })).find(x => x.link);
      const n = label.match(/(?:第\s*)?(\d{1,4})\s*[集期话]/)?.[1] || label.match(/^0*(\d{1,4})$/)?.[1];
      entries.push({ title: label || '播放链接', url: official?.link?.url || url,
        episode_number: n && Number(n) > 0 ? Number(n) : null,
        episode_type: /预告|\b(?:PV|trailer|teaser)\b/i.test(label) ? 'preview' : 'main',
        platform: official?.platform || null,
        link_type: official ? 'official_page' : /\.(?:m3u8|mp4|mpd)$/i.test(new URL(url).pathname) ? 'media' : 'external_page',
        playback_verified: false });
    }
    return [{ name, platform: sourcePlatform, episodes: entries.filter(e => e.episode_type === 'main'),
      previews: entries.filter(e => e.episode_type === 'preview') }];
  });
  return { id, title, source_id: source, source_name: definition?.name || (RESOURCE_SOURCES as Record<string,{name:string}>)[source]?.name || source, source: 'third_party',
    content_type: 'resource', year: text(v.vod_year), type_name: text(v.type_name), remarks: text(v.vod_remarks),
    updated_at: text(v.vod_time), detail_url: `/v1/resources/${source}/items/${encodeURIComponent(id)}`,
    play_sources: names, lines };
}

export function parseResourceResponse(body: string, source: ResourceSource, definition?: ResourceSourceConfig) {
  let rows: unknown[], page: number | null, pagecount: number | null, total: number | null;
  if (body.trimStart().startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new UpstreamError('RESOURCE_INVALID_JSON'); }
    const v = obj(value);
    // Some MacCMS APIs use null for a confirmed empty result, rather than [].
    const empty = v.list === null && v.total !== undefined && integer(v.total) === 0;
    if (Number(v.code) !== 1 || (!Array.isArray(v.list) && !empty)) throw new UpstreamError('RESOURCE_SCHEMA_CHANGED');
    rows = empty ? [] : v.list as unknown[]; page = integer(v.page); pagecount = integer(v.pagecount); total = integer(v.total);
  } else {
    if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new UpstreamError('RESOURCE_UNSAFE_XML');
    if (body.length > 512 * 1024) throw new UpstreamError('RESOURCE_XML_TOO_LARGE');
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<rss[\s>]/i.test(body)) throw new UpstreamError('RESOURCE_NOT_API_RESPONSE');
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'rss' || !root.querySelector('list')) throw new UpstreamError('RESOURCE_NOT_API_RESPONSE');
    const list = root.querySelector('list')!;
    page = integer(list.getAttribute('page')); pagecount = integer(list.getAttribute('pagecount')); total = integer(list.getAttribute('recordcount'));
    rows = [...list.querySelectorAll('video')].map(video => {
      const field = (name: string) => video.querySelector(name)?.textContent || '';
      const lines = [...video.querySelectorAll('dl > dd')];
      return { vod_id: field('id'), vod_name: field('name'), type_name: field('type'), vod_year: field('year'),
        vod_remarks: field('note'), vod_time: field('last'), vod_play_from: lines.map(x => x.getAttribute('flag') || '').join('$$$'),
        vod_play_url: lines.map(x => x.textContent || '').join('$$$') };
    });
  }
  if (rows.length > 500) throw new UpstreamError('RESOURCE_TOO_MANY_ITEMS');
  const seen = new Set<string>();
  const results = rows.flatMap(raw => {
    const item = parseItem(raw, source, definition);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id); return [item];
  });
  return { results, page, pagecount, total };
}

export async function searchResource(source: ResourceSource, query: string, page: number, env: Env, fetcher: Fetcher, itemId?: string, definition?: ResourceSourceConfig) {
  const config = definition || Object.entries(RESOURCE_SOURCES).map(([id,v])=>({id,...v})).find(v=>v.id===source);
  if(!config)throw new UpstreamError('UNKNOWN_RESOURCE_SOURCE');
  const u = new URL(config.endpoint);
  u.searchParams.set('ac', 'detail');
  if (itemId) u.searchParams.set('ids', itemId);
  else { u.searchParams.set('wd', query); u.searchParams.set('pg', String(page)); }
  const base = { source_id: source, source_name: definition?.name || (RESOURCE_SOURCES as Record<string,{name:string}>)[source]?.name || source, source: 'third_party' as const,
    source_url: u.href, cached: false, fetched_at: new Date().toISOString() };
  try {
    const load = async () => parseResourceResponse(await request(u.href, env, fetcher, { headers: { Accept: 'application/json, application/xml, text/xml' } }), source, config);
    let parsed = await load();
    // Some MacCMS variants only honor wd for ac=list. Never present an unfiltered feed as search results.
    if (!itemId && parsed.results.length && !parsed.results.some(x => score(query, x.title) >= 0.18)) {
      u.searchParams.set('ac', 'list');
      parsed = await load();
      if (parsed.results.length && !parsed.results.some(x => score(query, x.title) >= 0.18)) throw new UpstreamError('RESOURCE_SEARCH_NOT_HONORED');
    }
    if (!itemId && parsed.page !== null && parsed.page !== page) throw new UpstreamError('RESOURCE_PAGE_MISMATCH');
    const results = itemId ? parsed.results.filter(x => x.id === itemId) : parsed.results;
    return { ...base, source_url: u.href, status: results.length ? 'ok' as const : 'empty' as const, count: results.length,
      total: parsed.total, page: parsed.page ?? page, pagecount: parsed.pagecount,
      has_more: parsed.pagecount === null ? null : page < parsed.pagecount, results, warnings: [] as string[] };
  } catch (e) {
    return { ...base, status: 'unavailable' as const, count: 0, total: null, page, pagecount: null,
      has_more: null, results: [] as ResourceItem[], warnings: [e instanceof UpstreamError ? e.message : 'RESOURCE_REQUEST_FAILED'] };
  }
}
