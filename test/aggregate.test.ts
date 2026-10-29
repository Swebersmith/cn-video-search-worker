import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { PLATFORMS, type Fetcher } from '../src/types';

const json = (value: unknown) => new Response(JSON.stringify(value));
const upstream: Fetcher = async url => {
  if (url.includes('mesh.if')) return json({ data: { templates: [{ albumInfo: {
    title: '海市蜃楼', channel: '电视剧,2', siteId: 'iqiyi', qipuId: '12345', totalNumber: 24,
    videos: Array.from({ length: 24 }, (_, i) => ({ number: String(i + 1), title: `海市蜃楼第${i + 1}集`, pageUrl: `https://www.iqiyi.com/v_ep${i + 1}.html` })),
  } }] } });
  if (url.includes('pcw-api')) return json({ code: 'A00000', data: { albumId: '12345', total: 24, epsodelist: Array.from({ length: 24 }, (_, i) => ({ order: i + 1, name: `海市蜃楼第${i + 1}集`, playUrl: `https://www.iqiyi.com/v_ep${i + 1}.html`, contentType: 1 })) } });
  if (url.includes('qq.com')) return json({ data: { normalList: { itemList: [{ title: '海市蜃楼', url: 'https://v.qq.com/x/cover/abc/def.html' }] } } });
  if (url.includes('youku')) return new Response('<a href="https://v.youku.com/v_show/id_Xabc.html">海市蜃楼</a>');
  if (url.includes('mgtv')) return json({ code: 200, data: { contents: [{ title: '海市蜃楼', url: 'https://www.mgtv.com/b/123/456.html' }] } });
  return json({ code: 0, data: { result: [{ title: '海市蜃楼', url: 'https://www.bilibili.com/bangumi/play/ss1' }] } });
};
const req = (path: string) => new Request('https://example.test' + path);

test('legacy videos aggregate integrates all 24 episodes, removes duplicates and shares the upstream search request', async () => {
  const calls: string[] = [];
  const r = await createHandler(async (url, init) => { calls.push(url); return upstream(url, init); })(req('/v1/search?q=海市蜃楼&view=videos&limit=1'));
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.mode, 'all'); assert.equal(d.total, 28);
  const iq = d.results.filter((v: any) => v.platform === 'iqiyi');
  assert.equal(iq.length, 24); assert.deepEqual(iq.map((v: any) => v.episode_number), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(d.providers.find((p: any) => p.platform === 'iqiyi').catalog.complete, true);
  assert.equal(calls.filter(u => u.includes('mesh.if')).length, 1);
  assert.ok(calls.every(u => !u.includes('example.test')));
});
test('five dedicated endpoints return only their own platform content', async () => {
  for (const id of Object.keys(PLATFORMS)) {
    const r = await createHandler(upstream)(req(`/v1/${id}/search?q=海市蜃楼&view=videos`));
    const d = await r.json() as any;
    assert.equal(r.status, 200, id); assert.ok(d.results.length); assert.equal(d.providers.length, 1);
    assert.ok(d.results.every((v: any) => v.platform === id), id);
  }
});
test('aggregate subset and dedicated endpoint expose the same result contract', async () => {
  const handler = createHandler(upstream);
  const a = await (await handler(req('/v1/search?q=海市蜃楼&platforms=iqiyi&view=videos'))).json() as any;
  const b = await (await handler(req('/v1/iqiyi/search?q=海市蜃楼&view=videos'))).json() as any;
  assert.deepEqual(a.results, b.results); assert.equal(a.total, b.total); assert.equal(a.providers[0].catalog.complete, b.providers[0].catalog.complete);
});
test('search mode skips catalogs and episodes mode skips native search results', async () => {
  const calls: string[] = [];
  const handler = createHandler(async (url, init) => { calls.push(url); return upstream(url, init); });
  const a = await (await handler(req('/v1/iqiyi/search?q=海市蜃楼&mode=search&limit=2'))).json() as any;
  assert.equal(a.total, 2); assert.equal(a.providers[0].operations.episodes.status, 'skipped'); assert.equal(calls.some(u => u.includes('pcw-api')), false);
  const b = await (await handler(req('/v1/iqiyi/search?q=海市蜃楼&mode=episodes&limit=1'))).json() as any;
  assert.equal(b.total, 24); assert.equal(b.providers[0].operations.search.status, 'skipped'); assert.ok(b.results.every((v: any) => v.content_type === 'episode'));
});
test('unsupported episode adapters are explicit and never generate fake full catalogs', async () => {
  let calls = 0;
  const r = await createHandler(async () => { calls++; throw Error('unexpected'); })(req('/v1/tencent/search?q=海市蜃楼&mode=episodes'));
  const d = await r.json() as any;
  assert.equal(r.status, 422); assert.equal(d.providers[0].status, 'unsupported'); assert.equal(d.total, 0); assert.equal(calls, 0);
});
test('catalog failures preserve search results and expose the failing operation', async () => {
  const r = await createHandler(async (url, init) => url.includes('pcw-api') ? new Response('', { status: 403 }) : upstream(url, init))(req('/v1/iqiyi/search?q=海市蜃楼&view=videos&limit=1'));
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.partial, true); assert.equal(d.providers[0].catalog.complete, false);
  assert.equal(d.providers[0].operations.episodes.status, 'degraded'); assert.ok(d.results.length >= 1);
});
test('dedicated routes reject cross-site filters, invalid modes and unauthenticated requests before I/O', async () => {
  let calls = 0; const handler = createHandler(async () => { calls++; throw Error('unexpected'); });
  for (const path of ['/v1/iqiyi/search?q=海市蜃楼&platforms=tencent', '/v1/search?q=海市蜃楼&mode=garbage', '/v1/tencent/search?q=海市蜃楼&album_id=123']) assert.equal((await handler(req(path))).status, 400);
  assert.equal((await handler(req('/v1/iqiyi/search?q=海市蜃楼'), { API_KEY: 'secret' })).status, 401); assert.equal(calls, 0);
});
test('documentation and capabilities are public, static and protected by a strict script policy', async () => {
  const handler = createHandler(async () => { throw Error('unexpected network'); });
  const root = await handler(req('/'), { API_KEY: 'secret' });
  assert.match(root.headers.get('Content-Type') || '', /text\/html/); assert.match(await root.text(), /在线调试/);
  assert.match(root.headers.get('Content-Security-Policy') || '', /script-src 'self'/);
  assert.match((await handler(req('/assets/docs.js'))).headers.get('Content-Type') || '', /javascript/);
  const p = await (await handler(req('/v1/platforms'))).json() as any;
  assert.equal(p.platforms.length, 5); assert.equal(p.platforms.find((v: any) => v.id === 'iqiyi').episodes, true);
  assert.equal(p.platforms.find((v: any) => v.id === 'youku').episodes, true);
});
test('legacy episode URL remains a clearly deprecated compatibility route', async () => {
  const r = await createHandler(upstream)(req('/v1/episodes?q=海市蜃楼'));
  assert.equal(r.headers.get('Deprecation'), 'true'); assert.equal((await r.json() as any).total, 24);
});
