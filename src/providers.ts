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
