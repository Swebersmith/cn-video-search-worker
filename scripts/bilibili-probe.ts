import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Read-only diagnostics. Uses only Bilibili-issued anonymous cookies, never browser credentials.
const keyword = process.argv[2] || '三体';
const headers: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};
const cookies = new Map<string, string>();
const report: object[] = [];
async function probe(label: string, url: string) {
  try {
    const response = await fetch(url, { headers: { ...headers, Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }, signal: AbortSignal.timeout(10000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0,index), pair.slice(index+1));
    }
    const body = await response.text();
    let data: any; try { data = JSON.parse(body); } catch {}
    report.push({ label, http: response.status, code: data?.code, count: data?.data?.result?.length, api_ok: data?.code === 0,
      warnings: data?.providers?.[0]?.warnings });
    return data;
  } catch (e) { report.push({ label, error: e instanceof Error ? e.message : 'NETWORK_ERROR' }); }
}
await probe('anonymous_homepage', 'https://www.bilibili.com/');
const spi = await probe('anonymous_spi', 'https://api.bilibili.com/x/frontend/finger/spi');
if (spi?.code === 0) {
  for (const [key, value] of [['buvid3',spi.data?.b_3],['buvid4',spi.data?.b_4]])
    if (typeof value === 'string' && /^[a-z\d_-]{8,200}$/i.test(value)) cookies.set(key,value);
}
const nav = await probe('wbi_keys', 'https://api.bilibili.com/x/web-interface/nav');
const images = [nav?.data?.wbi_img?.img_url, nav?.data?.wbi_img?.sub_url];
const lookup = images.every(v => typeof v === 'string') ? images.map(v => new URL(v).pathname.split('/').at(-1)!.split('.')[0]).join('') : '';
const permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
await probe('legacy_bangumi', `https://api.bilibili.com/x/web-interface/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(keyword)}&page=1`);
if (lookup.length >= 64) {
  const mixin = permutation.map(i => lookup[i]).join('').slice(0,32);
  for (const type of ['media_bangumi','media_ft','video']) {
    const params: Record<string,string> = { keyword, page: '1', search_type: type, wts: String(Math.round(Date.now()/1000)) };
    const query = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k].replace(/[!'()*]/g,''))}`).join('&');
    await probe(`wbi_${type}`, `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${createHash('md5').update(query+mixin).digest('hex')}`);
  }
} else report.push({ label: 'wbi_search', skipped: 'WBI_KEYS_UNAVAILABLE' });
await probe('deployed_worker_series', `https://videosearch.webber.qzz.io/v1/bilibili/search?q=${encodeURIComponent(keyword)}&ai=off`);
const output = { checked_at: new Date().toISOString(), execution: 'local_node_network', keyword, report };
console.log(JSON.stringify(output,null,2));
await writeFile('docs/bilibili-live-2026-11-04.json', JSON.stringify(output,null,2)+'\n');
