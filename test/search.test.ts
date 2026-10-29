import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, ranked, score, video } from '../src/normalize';
import { extractHtml, extractJson, request, UpstreamError } from '../src/providers';
import { createHandler } from '../src/index';
import { searchPlatform } from '../src/search';
import type { CacheStore, Fetcher, ProviderResult } from '../src/types';

const response = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
const native: Fetcher = async url => {
  if (url.includes('pbaccess.video.qq.com')) return response({ data: { errcode: 0, normalList: { errcode: 0, itemList: [{ videoInfo: { title: '三体', episodeSites: [{ episodeInfoList: [{ title: '1', url: 'https://v.qq.com/x/cover/mzc002007knmh3g/i0045u918s5.html' }] }] } }] } } });
  if (url.includes('iqiyi')) return response({ data: { templates: [{ albumInfo: { title: '三体', pageUrl: 'https://www.iqiyi.com/v_test.html' } }] } });
  if (url.includes('youku')) return new Response('<a href="//v.youku.com/video?vid=Xabc=="><span>三体</span></a>');
  if (url.includes('mgtv')) return response({ code: 200, data: { contents: [{ title: '三体', url: 'https://www.mgtv.com/b/123/456.html' }] } });
  return response({ code: 0, data: { result: [{ title: '我的<em>三体</em>', url: 'https://www.bilibili.com/bangumi/play/ss45975' }] } });
};
const req = (query = 'q=三体') => new Request(`https://example.test/v1/search?${query}&mode=search`);
const failing: Fetcher = async () => new Response('denied', { status: 403 });
class MemoryCache implements CacheStore {
  values = new Map<string, Response>();
  async match(key: Request) { return this.values.get(key.url)?.clone(); }
  async put(key: Request, r: Response) { this.values.set(key.url, r.clone()); }
  async age(seconds: number) {
    for (const [key, value] of this.values) {
      const d = await value.json() as ProviderResult;
      d.fetched_at = new Date(Date.now() - seconds * 1000).toISOString();
      this.values.set(key, response(d));
    }
  }
}

test('official playback allowlist rejects lookalikes, credentials, media and non-playback pages', () => {
  for (const u of ['https://v.qq.com.evil.test/x/page/a.html', 'javascript:alert(1)', 'https://v.qq.com@evil.test/x/page/a.html', 'https://v.qq.com/x/search/?q=三体', 'https://v.qq.com/a.m3u8', 'https://v.qq.com:8443/x/page/a.html']) assert.equal(canonical(u, 'tencent'), undefined);
  assert.equal(canonical('https://www.iqiyi.com/a_abcd.html', 'iqiyi'), undefined);
  assert.equal(canonical('https://v.youku.com/video?vid=Xabc==&spm=tracking', 'youku')?.url, 'https://v.youku.com/v_show/id_Xabc==.html');
  assert.equal(canonical('http://v.qq.com/x/cover/abc.html?tracking=1', 'tencent')?.kind, 'series');
  assert.equal(canonical('https://www.bilibili.com/bangumi/play/ep1?from=search', 'bilibili')?.url, 'https://www.bilibili.com/bangumi/play/ep1');
});
test('fuzzy ranking favors exact and partial names, removes irrelevant and duplicate URLs', () => {
  assert.equal(score('三体', '三体'), 1);
  assert.ok(score('三体', '我的三体') > score('三体', '三国演义'));
  const a = video('iqiyi', '三体', '三体', 'https://www.iqiyi.com/v_a.html')!;
  const b = video('iqiyi', '三体', '我的三体', 'https://www.iqiyi.com/v_b.html')!;
  assert.deepEqual(ranked([b, a, a]).map(x => x.title), ['三体', '我的三体']);
});
test('Tencent numeric episode titles inherit the series name', () => {
  const out = extractJson({ title: '三体', episodes: [{ title: '1', url: 'https://v.qq.com/x/cover/abc/def.html' }] }, 'tencent', '三体');
  assert.equal(out[0]?.title, '三体 1');
});
test('Youku HTML parser handles nested markup, HTML entities and rejects external links', () => {
  const out = extractHtml('<a href="//v.youku.com/video?vid=Xabc==&amp;spm=1"><em>三体</em> 第1集</a><a href="https://evil.test/video">三体</a>', 'youku', '三体');
  assert.equal(out.length, 1); assert.equal(out[0].title, '三体 第1集');
});
test('unified API returns all five provider results with CORS and per-provider limits', async () => {
  const r = await createHandler(native)(req('q=三体&limit=1'));
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.total, 5); assert.equal(d.partial, false);
  assert.equal(d.providers.length, 5); assert.ok(d.providers.every((p: any) => p.status === 'ok'));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});
test('invalid parameters and missing auth cause no outbound requests', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; throw Error('must not call'); });
  for (const query of ['q=', 'q=...', 'q=三体&limit=0', 'q=三体&limit=1.2', 'q=三体&platforms=__proto__', 'q=三体&url=https://evil.test', 'q=三体&q=别的', `q=${'长'.repeat(81)}`, 'q=三体%00']) assert.equal((await handler(req(query))).status, 400, query);
  assert.equal((await handler(req(), { API_KEY: 'secret' })).status, 401);
  assert.equal(calls, 0);
});
test('Bearer and X-API-Key authentication are accepted', async () => {
  const cases: Record<string, string>[] = [{ Authorization: 'Bearer secret' }, { 'X-API-Key': 'secret' }];
  for (const headers of cases) {
    const r = await createHandler(native)(new Request(req(), { headers }), { API_KEY: 'secret' });
    assert.equal(r.status, 200);
  }
});
test('one failed platform does not prevent successful platforms returning data', async () => {
  const r = await createHandler(async (u, init) => u.includes('mgtv') ? failing(u, init) : native(u, init))(req());
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.partial, true); assert.equal(d.total, 4);
  assert.equal(d.providers.find((p: any) => p.platform === 'mango').status, 'unavailable');
});
test('all failed providers return 503 and Retry-After', async () => {
  const r = await createHandler(failing)(req());
  assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '30');
  assert.equal((await r.json() as any).ok, false);
});
test('Bilibili retains available category results and exposes failed-category degradation', async () => {
  const r = await createHandler(async (url, init) => url.includes('media_ft') ? failing(url, init) : native(url, init))(req('q=三体&platforms=bilibili'));
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.total, 1); assert.equal(d.partial, true);
  assert.equal(d.providers[0].status, 'degraded');
  assert.ok(d.providers[0].warnings.includes('native:PARTIAL_HTTP_403'));
});
test('Bilibili zero-result categories may omit the result array', async () => {
  const r = await createHandler(async () => response({ code: 0, data: { numResults: 0 } }))(req('q=不存在&platforms=bilibili'));
  assert.equal(r.status, 200); assert.equal((await r.json() as any).providers[0].status, 'empty');
});
test('upstream logical API errors are unavailable, not successful empty results', async () => {
  const r = await createHandler(async () => response({ data: { errcode: -300, normalList: { itemList: [] } } }))(req('q=三体&platforms=tencent'));
  assert.equal(r.status, 503);
});
test('Brave fallback returns only valid official playback pages and marks degradation', async () => {
  const fetcher: Fetcher = async (url, init) => {
    if (!url.includes('api.search.brave.com')) return failing(url, init);
    assert.equal((init?.headers as Record<string, string>)['X-Subscription-Token'], 'not-logged');
    return response({ web: { results: [
      { title: '三体', url: 'https://www.mgtv.com/b/123/456.html' },
      { title: '三体', url: 'https://evil.test/b/123/456.html' },
      { title: '三体', url: 'https://so.mgtv.com/so?k=三体' },
    ] } });
  };
  const r = await createHandler(fetcher)(req('q=三体&platforms=mango'), { BRAVE_SEARCH_API_KEY: 'not-logged' });
  const body = await r.text(), d = JSON.parse(body);
  assert.equal(d.results.length, 1); assert.equal(d.results[0].source, 'brave');
  assert.equal(d.providers[0].status, 'degraded'); assert.equal(d.partial, true);
  assert.ok(!body.includes('not-logged'));
});
test('fresh cache suppresses repeated network requests', async () => {
  const cache = new MemoryCache(); let calls = 0;
  const fetcher: Fetcher = async (url, init) => { calls++; return native(url, init); };
  const handler = createHandler(fetcher, cache);
  await handler(req('q=三体&platforms=iqiyi'));
  const r = await handler(req('q=三体&platforms=iqiyi&limit=1'));
  assert.equal(calls, 1); assert.equal((await r.json() as any).providers[0].cached, true);
});
test('cache survives upstream errors with explicit stale age and status', async () => {
  const cache = new MemoryCache();
  await searchPlatform('iqiyi', '三体', {}, native, cache);
  await cache.age(600);
  const out = await searchPlatform('iqiyi', '三体', {}, failing, cache);
  assert.equal(out.status, 'stale'); assert.equal(out.results.length, 1);
  assert.ok(Date.now() - Date.parse(out.fetched_at) >= 599000);
  assert.ok(out.warnings.includes('STALE_RESULTS_NOT_REVALIDATED'));
});
test('expired stale cache is discarded and stale data never overrides a genuine empty response', async () => {
  const cache = new MemoryCache();
  await searchPlatform('iqiyi', '三体', {}, native, cache);
  await cache.age(90000);
  assert.equal((await searchPlatform('iqiyi', '三体', {}, failing, cache)).status, 'unavailable');
  await searchPlatform('iqiyi', '三体', {}, native, cache);
  await cache.age(600);
  const out = await searchPlatform('iqiyi', '三体', {}, async () => response({ data: { templates: [] } }), cache);
  assert.equal(out.status, 'empty'); assert.equal(out.results.length, 0);
});
test('Brave rate limits stay visible and are never cached as healthy empty results', async () => {
  const cache = new MemoryCache();
  const out = await searchPlatform('mango', '三体', { BRAVE_SEARCH_API_KEY: 'secret' }, async () => new Response('', { status: 429 }), cache);
  assert.equal(out.status, 'unavailable'); assert.ok(out.warnings.includes('brave:HTTP_429'));
  assert.equal(cache.values.size, 0);
});
test('upstream body limits and deadlines terminate requests', async () => {
  await assert.rejects(request('https://example.test', {}, async () => new Response('', { headers: { 'Content-Length': '9999999' } })), /RESPONSE_TOO_LARGE/);
  const pending: Fetcher = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(request('https://example.test', { UPSTREAM_TIMEOUT_MS: '1000' }, pending), (e: unknown) => e instanceof UpstreamError && e.message === 'TIMEOUT');
});
test('health, OpenAPI and preflight are available without upstream or API key', async () => {
  const handler = createHandler(failing);
  for (const path of ['/health', '/openapi.json', '/v1/platforms']) assert.equal((await handler(new Request(`https://example.test${path}`), { API_KEY: 'secret' })).status, 200);
  assert.equal((await handler(new Request('https://example.test/v1/search', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handler(new Request('https://example.test/v1/search', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('https://example.test/missing'))).status, 404);
});
