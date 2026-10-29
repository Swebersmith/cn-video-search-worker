import { bounded, PLATFORMS, type Env, type Fetcher, type Platform, type Video } from './types';
import { ranked, text, video } from './normalize';

export class UpstreamError extends Error {}
export class PartialUpstreamError extends UpstreamError {
  constructor(message: string, public results: Video[]) { super(message); }
}
const UA = 'Mozilla/5.0 (compatible; CNVideoSearch/1.0)';
const MAX_BYTES = 3 * 1024 * 1024;
export async function request(url: string, env: Env, fetcher: Fetcher, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounded(env.UPSTREAM_TIMEOUT_MS, 6000, 1000, 10000));
  try {
    const r = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...init.headers } });
    if (!r.ok) { await r.body?.cancel(); throw new UpstreamError(`HTTP_${r.status}`); }
    if (Number(r.headers.get('content-length')) > MAX_BYTES) { await r.body?.cancel(); throw new UpstreamError('RESPONSE_TOO_LARGE'); }
    const reader = r.body?.getReader();
    if (!reader) throw new UpstreamError('EMPTY_BODY');
    const decoder = new TextDecoder(); let size = 0, body = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new UpstreamError('RESPONSE_TOO_LARGE'); }
      body += decoder.decode(part.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
  } finally { clearTimeout(timer); }
}
export function json(body: string): any {
  try { return JSON.parse(body); } catch { throw new UpstreamError('INVALID_JSON'); }
}

// Walk structured result objects only; never execute page scripts or synthesize URLs from unverified IDs.
export function extractJson(data: unknown, platform: Platform, query: string): Video[] {
  const found: Video[] = []; let visited = 0;
  function walk(value: unknown, depth = 0, parentTitle = ''): void {
    if (!value || typeof value !== 'object' || depth > 22 || ++visited > 16000) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, parentTitle); return; }
    const obj = value as Record<string, unknown>;
    const params = obj.item_params && typeof obj.item_params === 'object' ? obj.item_params as Record<string, unknown> : {};
    const ownTitle = text(obj.title || obj.name || obj.videoName || obj.video_name || obj.tempTitle || params.title);
    const title = parentTitle && /^(\d+|第?[\d一二三四五六七八九十]+集|立即播放|正片|彩蛋\d*)$/.test(ownTitle)
      ? `${parentTitle} ${ownTitle}` : ownTitle || parentTitle;
    for (const key of ['pageUrl', 'url', 'playUrl', 'play_url', 'web_url', 'video_url', 'jumpUrl', 'jump_url', 'goto_url', 'action_url', 'value']) {
      const item = video(platform, query, title, obj[key] || params[key]);
      if (item) found.push(item);
    }
    for (const v of Object.values(obj)) walk(v, depth + 1, title);
  }
  walk(data);
  return ranked(found);
}
export function extractHtml(body: string, platform: Platform, query: string): Video[] {
  const found: Video[] = [];
  for (const match of body.matchAll(/<a\b([^>]{0,12000})>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = match[1];
    const attr = (key: string) => attrs.match(new RegExp(`\\b${key}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
    const title = attr('title') || text(match[2]);
    const item = video(platform, query, title, attr('href'));
    if (item) found.push(item);
  }
  return ranked(found);
}

export type IqiyiSearchLoader = () => Promise<unknown>;
export async function iqiyiSearchData(query: string, env: Env, fetcher: Fetcher): Promise<unknown> {
  return json(await request(`https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?key=${encodeURIComponent(query)}&version=14.9.0&size=20&pageNum=1&source=pcw`, env, fetcher));
}
export async function tencentSearchData(query: string, env: Env, fetcher: Fetcher): Promise<unknown> {
  return json(await request('https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vversion_platform=2', env, fetcher, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://v.qq.com', Referer: 'https://v.qq.com/' },
    body: JSON.stringify({ version: '2', clientType: 1, filterValue: '', uuid: crypto.randomUUID(), retry: 0, query, pagenum: 0, pagesize: 20, queryFrom: 0, searchSession: '', featureList: [] }),
  }));
}
export async function youkuSearchData(query: string, env: Env, fetcher: Fetcher): Promise<unknown> {
  const d = json(await request(`https://search.youku.com/api/search?keyword=${encodeURIComponent(query)}&pg=1&pz=20`, env, fetcher));
  if (d.message !== 'success' || !Array.isArray(d.originNodes)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
  return { data: { nodes: d.originNodes } };
}
export async function nativeSearch(platform: Platform, query: string, env: Env, fetcher: Fetcher, loadIqiyi?: IqiyiSearchLoader): Promise<Video[]> {
  const q = encodeURIComponent(query);
  if (platform === 'iqiyi') {
    const d = await (loadIqiyi ? loadIqiyi() : iqiyiSearchData(query, env, fetcher)) as { data?: { templates?: unknown } };
    if (!Array.isArray(d?.data?.templates)) throw new UpstreamError('SCHEMA_CHANGED');
    return extractJson(d.data.templates, platform, query);
  }
  if (platform === 'bilibili') {
    const batches = await Promise.allSettled(['media_bangumi', 'media_ft'].map(async type => {
      const d = json(await request(`https://api.bilibili.com/x/web-interface/search/type?search_type=${type}&keyword=${q}&page=1`, env, fetcher, { headers: { Referer: 'https://www.bilibili.com/' } }));
      if (d.code !== 0) throw new UpstreamError(`API_${Number(d.code) || 'ERROR'}`);
      if (!Array.isArray(d?.data?.result) && Number(d?.data?.numResults) === 0) return [];
      if (!Array.isArray(d?.data?.result)) throw new UpstreamError('SCHEMA_CHANGED');
      return extractJson(d.data.result, platform, query);
    }));
    // A failed category must be visible and eligible for fallback; never silently label it complete.
    const failure = batches.find(b => b.status === 'rejected');
    const items = ranked(batches.flatMap(b => b.status === 'fulfilled' ? b.value : []));
    if (failure?.status === 'rejected') {
      if (items.length) throw new PartialUpstreamError(`PARTIAL_${failure.reason instanceof UpstreamError ? failure.reason.message : 'CATEGORY_ERROR'}`, items);
      throw failure.reason;
    }
    return items;
  }
  if (platform === 'youku') {
    try {
      const html = await request(`https://so.youku.com/search_video/q_${q}`, env, fetcher);
      const results = extractHtml(html, platform, query);
      if (results.length || /没有找到|暂无|无相关|未找到/.test(html)) return results;
    } catch { /* The official structured search can survive a failed web entry point. */ }
    return extractJson(await youkuSearchData(query, env, fetcher), platform, query);
  }
  if (platform === 'tencent') {
    const d = await tencentSearchData(query, env, fetcher) as Record<string, any>;
    if ((d.ret !== undefined && Number(d.ret) !== 0) || (d.errcode !== undefined && Number(d.errcode) !== 0)) throw new UpstreamError('API_REJECTED');
    const root = d.data ?? d;
    if (root.errcode !== undefined && Number(root.errcode) !== 0) throw new UpstreamError('API_REJECTED');
    if (root.normalList?.errcode !== undefined && Number(root.normalList.errcode) !== 0) throw new UpstreamError('API_REJECTED');
    if (!root.normalList && !root.itemList && !root.result) throw new UpstreamError('SCHEMA_CHANGED');
    const items = extractJson(root, platform, query);
    if (!items.length && JSON.stringify(root).includes('v.qq.com')) throw new UpstreamError('SCHEMA_CHANGED');
    return items;
  }
  const d = json(await request(`https://mobileso.bz.mgtv.com/pc/search/v1?q=${q}&pn=1&pc=20&corr=1`, env, fetcher, { headers: { Referer: 'https://so.mgtv.com/' } }));
  if (d.code !== undefined && ![0, 200, '0', '200'].includes(d.code)) throw new UpstreamError('API_REJECTED');
  if (d.data?.forbidden) throw new UpstreamError('API_FORBIDDEN');
  if (!d.data || typeof d.data !== 'object') throw new UpstreamError('SCHEMA_CHANGED');
  return extractJson(d.data, platform, query);
}

export async function braveSearch(platform: Platform, query: string, env: Env, fetcher: Fetcher): Promise<Video[]> {
  const search = encodeURIComponent(`${query} site:${PLATFORMS[platform].domain}`);
  const d = json(await request(`https://api.search.brave.com/res/v1/web/search?q=${search}&count=20&search_lang=zh-hans`, env, fetcher, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY! },
  }));
  if (!Array.isArray(d?.web?.results)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
  return ranked(d.web.results.map((r: any) => video(platform, query, r.title, r.url, 'brave')).filter((v: Video | undefined): v is Video => Boolean(v)));
}
