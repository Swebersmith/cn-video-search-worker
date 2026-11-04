import { bounded, type Env, type Fetcher } from './types';
import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export class UpstreamError extends Error {}
const UA = 'Mozilla/5.0 (compatible; CNVideoSearch/1.0)';
const MAX_BYTES = 3 * 1024 * 1024;
export async function request(url: string, env: Env, fetcher: Fetcher, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounded(env.UPSTREAM_TIMEOUT_MS, 6000, 1000, 10000));
  try {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...init.headers };
    const r = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal, headers });
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

const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

// One anonymous session per incoming request, shared by parallel category queries.
// Bootstrap before searching, as documented by bilibili-api-collect/search/search_request.md.
export function bilibiliSessionFetcher(env: Env, fetcher: Fetcher): Fetcher {
  let session: Promise<string> | undefined, refreshed: Promise<string> | undefined;
  async function bootstrap(): Promise<string> {
    const cookies = new Map<string, string>();
    try {
      await request('https://www.bilibili.com/', env, async (url, init) => {
        const response = await fetcher(url, init);
        for (const raw of response.headers.getSetCookie()) {
          const [pair, ...attributes] = raw.split(';'), index = pair.indexOf('=');
          const domain = attributes.find(a => /^\s*domain=/i.test(a))?.split('=')[1]?.trim().replace(/^\./,'').toLowerCase();
          const path = attributes.find(a => /^\s*path=/i.test(a))?.split('=')[1]?.trim();
          if ((domain && !['bilibili.com','www.bilibili.com'].includes(domain)) || (path && path !== '/')) continue;
          const name = pair.slice(0,index).trim(), value = pair.slice(index+1).trim();
          if (index > 0 && /^[\w-]{1,80}$/.test(name) && /^[\x21-\x3A\x3C-\x7E]{1,4096}$/.test(value)) cookies.set(name,value);
        }
        return response;
      }, { headers: BILIBILI_HEADERS });
    } catch { /* The public SPI endpoint can still issue device cookies. */ }
    if (!cookies.has('buvid3')) try {
      const data = json(await request('https://api.bilibili.com/x/frontend/finger/spi', env, fetcher, { headers: BILIBILI_HEADERS }));
      if (data.code === 0) for (const [name,value] of [['buvid3',data.data?.b_3],['buvid4',data.data?.b_4]])
        if (typeof value === 'string' && /^[a-z\d_-]{8,200}$/i.test(value)) cookies.set(name,value);
    } catch { /* Surface the actual search/detail response, never fabricate cookies. */ }
    return [...cookies].map(([name,value]) => `${name}=${value}`).join('; ');
  }
  return async (url, init = {}) => {
    const target = new URL(url);
    if (!['api.bilibili.com', 'www.bilibili.com', 'search.bilibili.com'].includes(target.hostname)) return fetcher(url, init);
    session ??= bootstrap();
    const cookie = await session;
    const incoming = new Headers(init.headers);
    incoming.delete('Cookie');
    const headers = { ...Object.fromEntries(incoming), ...BILIBILI_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
    const first = await fetcher(url, { ...init, headers });
    let rejected = first.status === 412;
    if (!rejected && first.ok && target.pathname.includes('/search/')) try {
      // Inspect a bounded clone: HTTP 200 with JSON code=-412 is also rejection.
      const payload = json(await request(url, env, async () => first.clone()));
      rejected = [-412, -352].includes(payload.code);
    } catch { /* Let the caller validate malformed/oversized payloads. */ }
    if (!rejected) return first;
    refreshed ??= bootstrap();
    session = refreshed;
    const nextCookie = await refreshed;
    if (!nextCookie) return first;
    await first.body?.cancel();
    return fetcher(url, { ...init, headers: { ...headers, Cookie: nextCookie } });
  };
}

const WBI_PERMUTATION = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function bilibiliWbiQuery(params: Record<string,string>, imgKey: string, subKey: string, now = Date.now()): string {
  if (!/^[a-f\d]{32}$/i.test(imgKey) || !/^[a-f\d]{32}$/i.test(subKey)) throw new UpstreamError('WBI_KEYS_UNAVAILABLE');
  const lookup = imgKey + subKey, mixin = WBI_PERMUTATION.map(i => lookup[i]).join('').slice(0,32);
  const values: Record<string,string> = { ...params, wts: String(Math.round(now / 1000)) };
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(values[k].replace(/[!'()*]/g,''))}`).join('&');
  return query + '&w_rid=' + bytesToHex(md5(new TextEncoder().encode(query + mixin)));
}
export type BilibiliMediaType = 'media_bangumi' | 'media_ft';
export function bilibiliSearchLoader(env: Env, fetcher: Fetcher) {
  let keys: Promise<[string,string]> | undefined;
  return async (query: string, type?: BilibiliMediaType): Promise<any> => {
    keys ??= (async () => {
      const nav = json(await request('https://api.bilibili.com/x/web-interface/nav', env, fetcher, { headers: BILIBILI_HEADERS }));
      // Anonymous nav may return -101 while still providing valid public WBI keys.
      const key = (url: unknown) => typeof url === 'string' ? url.match(/\/([a-f\d]{32})\.[a-z]+(?:\?.*)?$/i)?.[1] || '' : '';
      return [key(nav.data?.wbi_img?.img_url), key(nav.data?.wbi_img?.sub_url)];
    })();
    const [img,sub] = await keys;
    const params: Record<string,string> = { keyword: query, page: '1', ...(type ? { search_type: type } : {}) };
    const signed = bilibiliWbiQuery(params,img,sub);
    const payload = json(await request(`https://api.bilibili.com/x/web-interface/wbi/search/${type ? 'type' : 'all/v2'}?${signed}`, env, fetcher, { headers: BILIBILI_HEADERS }));
    if (payload.code !== 0) throw new UpstreamError(`API_${Number(payload.code) || 'ERROR'}`);
    return payload;
  };
}

export type IqiyiSearchLoader = () => Promise<unknown>;
export async function iqiyiSearchData(query: string, env: Env, fetcher: Fetcher, page = 1): Promise<unknown> {
  return json(await request(`https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?key=${encodeURIComponent(query)}&version=14.9.0&size=20&pageNum=${page}&source=pcw`, env, fetcher));
}
export async function tencentSearchData(query: string, env: Env, fetcher: Fetcher, page = 1): Promise<unknown> {
  return json(await request('https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vversion_platform=2', env, fetcher, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://v.qq.com', Referer: 'https://v.qq.com/' },
    body: JSON.stringify({ version: '2', clientType: 1, filterValue: '', uuid: crypto.randomUUID(), retry: 0, query, pagenum: page - 1, pagesize: 20, queryFrom: 0, searchSession: '', featureList: [] }),
  }));
}
// Parameters and public request checksum follow the search module on so.mgtv.com.
// Source: static.hitv.com/pc/2.6e76f43.js, module 1304 (2026-10-29).
export function mangoSearchUrl(query: string, page = 1, now = new Date(), nonce = crypto.randomUUID()): string {
  const params: Record<string, string> = { src:'mgtv', did:crypto.randomUUID(), timestamp:now.toISOString().replace(/\.\d{3}Z/, 'Z'), signVersion:'1', signNonce:nonce.replaceAll('-', ''), q:query, pn:String(page), pc:'10', corr:'1' };
  const sorted = Object.keys(params).sort((a,b) => a.localeCompare(b)).map(k => `${encodeURI(k)}=${encodeURI(params[k])}`).join('&');
  const marker = 'xHAa3YZflWLogZUOzl'; // Public frontend constant, not an account credential.
  params.signature = bytesToHex(md5(new TextEncoder().encode(marker + sorted + marker)));
  const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return 'https://mobileso.bz.mgtv.com/pc/search/v2?' + Object.entries(params).map(([k,v]) => `${encode(k)}=${encode(v)}`).join('&');
}
export async function mangoSearchData(query: string, env: Env, fetcher: Fetcher, page = 1): Promise<any> {
  const d = json(await request(mangoSearchUrl(query, page), env, fetcher, {headers:{Referer:'https://so.mgtv.com/'}}));
  if (![200, 0, '200', '0'].includes(d.code) || d.data?.forbidden) throw new UpstreamError('SEARCH_API_REJECTED');
  if (!Array.isArray(d.data?.contents)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
  return d;
}
export async function youkuSearchData(query: string, env: Env, fetcher: Fetcher): Promise<unknown> {
  const d = json(await request(`https://search.youku.com/api/search?keyword=${encodeURIComponent(query)}&pg=1&pz=20`, env, fetcher));
  if (d.message !== 'success' || !Array.isArray(d.originNodes)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
  return { data: { nodes: d.originNodes } };
}
