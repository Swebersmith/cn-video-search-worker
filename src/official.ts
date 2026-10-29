import { PLATFORMS, type Platform, type Env, type Fetcher } from './types';
import { iqiyiSearchData, tencentSearchData, mangoSearchData, request, json, UpstreamError } from './providers';
import { text } from './normalize';

type Obj = Record<string, any>;
const obj = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const array = (x: unknown): any[] => Array.isArray(x) ? x : [];
// Search cards can link to people, articles, creators and other official platforms.
// This is intentionally broader than the catalogue's playback URL allowlist.
export function officialLink(raw: unknown, platform: Platform): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
  try {
    const u = new URL(raw, `https://${PLATFORMS[platform].domain}`);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    if (!['qq.com','iqiyi.com','youku.com','mgtv.com','bilibili.com'].some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
    u.protocol = 'https:';
    return u.href;
  } catch { return null; }
}
function fields(raw: unknown, platform: Platform): {title: string; url: string | null} {
  let title = '', url: string | null = null, count = 0;
  function walk(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16 || ++count > 12000) return;
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    const o = obj(value);
    title ||= text(o.title || o.tempTitle || o.name || o.hitTitle || o.uname || o.author || obj(o.titleDTO).displayName);
    for (const k of ['pageUrl','url','playUrl','arcurl','link','jumpUrl','value','uri']) url ||= officialLink(o[k], platform);
    for (const v of Object.values(o)) walk(v, depth + 1);
  }
  walk(raw);
  return {title, url};
}

export async function officialSearch(platform: Platform, query: string, page: number, env: Env, fetcher: Fetcher) {
  const search_url = PLATFORMS[platform].search + encodeURIComponent(query);
  const base = {platform, page, search_url, source:'official' as const, cached:false, fetched_at:new Date().toISOString()};
  const warnings: string[] = [];
  try {
    let payload: any, rows: {raw: unknown; type: string}[] = [], total: number | null = null, hasMore: boolean | null = null, sourceUrl = '';
    if (platform === 'iqiyi') {
      payload = await iqiyiSearchData(query, env, fetcher, page);
      if (!Array.isArray(payload?.data?.templates)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
      rows = payload.data.templates.map((raw: Obj) => ({raw, type:String(raw.template)}));
      total = Number(payload.data.resultNum) || null;
      if (total !== null) hasMore = page * (Number(payload.data.pageSize) || 20) < total;
      sourceUrl = 'https://mesh.if.iqiyi.com/portal/lw/search/homePageV3';
    } else if (platform === 'tencent') {
      payload = await tencentSearchData(query, env, fetcher, page);
      const data = obj(payload.data), normal = obj(data.normalList);
      if ((payload.ret !== undefined && Number(payload.ret) !== 0) || (data.errcode !== undefined && Number(data.errcode) !== 0) ||
          (normal.errcode !== undefined && Number(normal.errcode) !== 0)) throw new UpstreamError('SEARCH_API_REJECTED');
      if (!Array.isArray(normal.itemList)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
      function appendTencent(items: unknown[], active: Set<number>, depth = 0) {
        if (depth > 12) throw new UpstreamError('SEARCH_LAYOUT_TOO_DEEP');
        for (const raw of items) {
          const card = obj(raw), refs = array(obj(card.doc).areaBoxIndex);
          if (refs.length) {
            for (const index of refs) {
              const box = array(data.areaBoxList)[index];
              if (!Number.isInteger(index) || !box || !Array.isArray(box.itemList) || active.has(index)) throw new UpstreamError('SEARCH_LAYOUT_CHANGED');
              appendTencent(box.itemList, new Set([...active, index]), depth + 1);
            }
          } else rows.push({raw,type:String(obj(card.doc).dataType ?? card.type ?? card.itemType ?? 'card')});
        }
      }
      appendTencent(normal.itemList,new Set());
      if (typeof normal.hasMore === 'boolean') hasMore = normal.hasMore;
      sourceUrl = 'https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch';
    } else if (platform === 'youku') {
      sourceUrl = `https://search.youku.com/api/search?keyword=${encodeURIComponent(query)}&pg=${page}&pz=20`;
      payload = json(await request(sourceUrl, env, fetcher, {headers:{Referer:'https://search.youku.com/'}}));
      if (payload.message !== 'success' || !Array.isArray(payload.pageComponentList)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
      rows = payload.pageComponentList.map((raw: Obj) => ({raw,type:array(raw.componentKeyList).join(',')}));
      if (typeof payload.more === 'boolean') hasMore = payload.more;
      total = Number(payload.pageData?.total) || null;
    } else if (platform === 'mango') {
      payload = await mangoSearchData(query, env, fetcher, page);
      rows = payload.data.contents.map((raw: Obj) => ({raw,type:String(raw.type ?? 'card')}));
      total = Number(payload.data.totalHits) || null;
      if (typeof payload.data.hasMore === 'boolean') hasMore = payload.data.hasMore;
      sourceUrl = 'https://mobileso.bz.mgtv.com/pc/search/v2';
    } else {
      sourceUrl = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}&page=${page}`;
      const headers: Record<string,string> = {Referer:'https://search.bilibili.com/','User-Agent':'Mozilla/5.0'};
      try { payload = json(await request(sourceUrl, env, fetcher, {headers})); }
      catch (e) {
        if (!(e instanceof UpstreamError) || e.message !== 'HTTP_412') throw e;
        // Initialize the website's own anonymous session; never fabricate cookies or borrow search data.
        warnings.push('initial:HTTP_412');
        const session = json(await request('https://api.bilibili.com/x/frontend/finger/spi',env,fetcher,{headers}));
        const b3 = session.data?.b_3, b4 = session.data?.b_4;
        if (session.code !== 0 || typeof b3 !== 'string' || typeof b4 !== 'string' || !/^[a-z\d_-]{8,200}$/i.test(b3) || !/^[a-z\d_-]{8,200}$/i.test(b4)) throw new UpstreamError('OFFICIAL_SESSION_UNAVAILABLE');
        payload = json(await request(sourceUrl,env,fetcher,{headers:{...headers,Cookie:`buvid3=${b3}; buvid4=${b4}`}}));
      }
      if (payload.code !== 0) throw new UpstreamError(`API_${payload.code}`);
      if (!Array.isArray(payload.data?.result)) throw new UpstreamError('SEARCH_SCHEMA_CHANGED');
      for (const group of payload.data.result) {
        for (const raw of array(group.data)) rows.push({raw,type:String(group.result_type)});
      }
      total = Number(payload.data.numResults) || null;
      if (Number.isFinite(payload.data.numPages)) hasMore = page < payload.data.numPages;
    }
    // Preserve the website response order and every card, including unknown templates.
    // No fuzzy threshold, deduplication, category filter, or local limit is applied.
    const results = rows.map(({raw,type}, i) => {
      const f = fields(raw, platform);
      if (!f.title && obj(raw).staticRelateSearchWord) f.title = '相关搜索';
      return {platform, platform_name:PLATFORMS[platform].name, rank:i+1, content_type:'official' as const,
        type_name:type, title:f.title || `官网结果 ${i+1}`, url:f.url, raw};
    });
    return {...base,status:results.length?'ok':'empty',count:results.length,total,has_more:hasMore,source_url:sourceUrl,warnings,results,upstream:payload};
  } catch (e) {
    return {...base,status:'unavailable',count:0,total:null,has_more:null,source_url:null,
      warnings:[...warnings,e instanceof UpstreamError?e.message:'UPSTREAM_ERROR'],results:[],upstream:null};
  }
}
