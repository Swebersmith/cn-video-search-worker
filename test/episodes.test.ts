import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import type { Fetcher } from '../src/types';

const aid = '6244560312265801';
const series = { title: '海市蜃楼', channel: '电视剧,2', siteId: 'iqiyi', qipuId: aid, totalNumber: 24, year: { value: '2025' }, videos: [{ number: '1', title: '海市蜃楼第1集', pageUrl: 'https://www.iqiyi.com/v_ep1.html' }] };
const episode = (n: number) => ({ order: n, name: `海市蜃楼第${n}集`, playUrl: `http://www.iqiyi.com/v_ep${n}.html`, contentType: 1, effective: true });
const json = (data: unknown) => new Response(JSON.stringify(data));
const search = (albums: unknown[] = [series]) => json({ data: { templates: albums.map(albumInfo => ({ albumInfo })) } });
const catalog = (items = Array.from({ length: 24 }, (_, i) => episode(i + 1)), total = 24) => json({ code: 'A00000', data: { albumId: aid, epsodelist: items, total, hasMore: false } });
const req = (params = 'q=海市蜃楼') => new Request(`https://example.test/v1/episodes?${params}`);

test('episode catalog returns all 24 episodes in numeric order without mixing same-name movie or trailers', async () => {
  const fetcher: Fetcher = async url => url.includes('mesh.if')
    ? search([{ ...series, channel: '电影,1', qipuId: '22' }, series])
    : catalog([...Array.from({ length: 24 }, (_, i) => episode(24 - i)), { ...episode(25), name: '海市蜃楼预告', contentType: 3 }, episode(1)]);
  const r = await createHandler(fetcher)(req()); const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.total, 24); assert.equal(d.complete, true);
  assert.deepEqual(d.results.map((e: any) => e.episode_number), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(d.series.album_id, aid); assert.equal(d.series_candidates.length, 1);
  assert.ok(d.results.every((e: any) => e.url.startsWith('https://www.iqiyi.com/v_')));
});
test('missing episode numbers and malformed links cannot be reported as a complete catalog', async () => {
  const r = await createHandler(async url => url.includes('mesh.if') ? search() : catalog([episode(1), { ...episode(2), playUrl: 'https://evil.test/v_ep2.html' }, episode(24)]))(req());
  const d = await r.json() as any;
  assert.equal(d.complete, false); assert.equal(d.expected_total, 24); assert.ok(d.missing_episode_numbers.includes(2));
  assert.equal(d.total, 2);
});
test('catalog failures retain search previews with an explicit incomplete status', async () => {
  const r = await createHandler(async url => url.includes('mesh.if') ? search() : new Response('', { status: 403 }))(req());
  const d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.total, 1); assert.equal(d.complete, false);
  assert.ok(d.warnings.includes('SEARCH_PREVIEW_FALLBACK')); assert.ok(d.warnings.includes('album:HTTP_403'));
});
test('catalog pagination handles series longer than 100 episodes', async () => {
  const r = await createHandler(async url => {
    if (url.includes('mesh.if')) return search([{ ...series, totalNumber: 124 }]);
    const page = Number(new URL(url).searchParams.get('page'));
    return catalog(Array.from({ length: page === 1 ? 100 : 24 }, (_, i) => episode(i + (page === 1 ? 1 : 101))), 124);
  })(req());
  const d = await r.json() as any;
  assert.equal(d.total, 124); assert.equal(d.complete, true); assert.equal(d.results.at(-1).episode_number, 124);
});
test('failed catalog pages retain available results without claiming completeness', async () => {
  const r = await createHandler(async url => {
    if (url.includes('mesh.if')) return search([{ ...series, totalNumber: 124 }]);
    return new URL(url).searchParams.get('page') === '1' ? catalog(Array.from({ length: 100 }, (_, i) => episode(i + 1)), 124) : new Response('', { status: 429 });
  })(req());
  const d = await r.json() as any;
  assert.equal(d.total, 100); assert.equal(d.complete, false); assert.ok(d.warnings.includes('album:HTTP_429'));
});
test('conflicting URLs for the same episode cannot produce complete=true', async () => {
  const r = await createHandler(async url => url.includes('mesh.if') ? search() : catalog([...Array.from({ length: 24 }, (_, i) => episode(i + 1)), { ...episode(1), playUrl: 'https://www.iqiyi.com/v_other.html' }]))(req());
  const d = await r.json() as any;
  assert.equal(d.complete, false); assert.ok(d.warnings.includes('CONFLICTING_EPISODE_DATA'));
});
test('album selection and validation prevent cross-album mixtures or arbitrary URL input', async () => {
  let calls = 0;
  const handler = createHandler(async url => { calls++; return url.includes('mesh.if') ? search() : catalog(); });
  for (const params of ['q=海市蜃楼&platform=tencent', 'q=海市蜃楼&url=https://evil.test', 'q=海市蜃楼&album_id=abc', 'q=海市蜃楼&limit=5']) assert.equal((await handler(req(params))).status, 400);
  assert.equal((await handler(req(), { API_KEY: 'secret' })).status, 401); assert.equal(calls, 0);
  assert.equal((await handler(req('q=海市蜃楼&album_id=999'))).status, 404);
});
test('same-name movies alone do not count as a TV series', async () => {
  const r = await createHandler(async () => search([{ ...series, channel: '电影,1' }]))(req());
  assert.equal(r.status, 404);
});
test('complete catalogs use an independent cache and preserve all episode numbers', async () => {
  const values = new Map<string, Response>(); let calls = 0;
  const handler = createHandler(async url => { calls++; return url.includes('mesh.if') ? search() : catalog(); }, {
    async match(key) { return values.get(key.url)?.clone(); },
    async put(key, value) { values.set(key.url, value.clone()); },
  });
  await handler(req()); const d = await (await handler(req())).json() as any;
  assert.equal(calls, 2); assert.equal(d.cached, true); assert.equal(d.total, 24);
});
test('search responses disclose the default per-platform cap instead of implying five total episodes', async () => {
  const r = await createHandler(async () => search([{ ...series, videos: Array.from({ length: 24 }, (_, i) => ({ title: `海市蜃楼第${i + 1}集`, pageUrl: `https://www.iqiyi.com/v_ep${i + 1}.html` })) }]))(new Request('https://example.test/v1/search?q=海市蜃楼&platforms=iqiyi'));
  const d = await r.json() as any;
  assert.equal(d.total, 5); assert.equal(d.limit, 5); assert.equal(d.providers[0].available_count, 24); assert.equal(d.providers[0].truncated, true);
});
test('catalog page caps remain bounded and never claim that a 501-episode series is complete', async () => {
  let calls = 0;
  const r = await createHandler(async url => {
    calls++;
    if (url.includes('mesh.if')) return search([{ ...series, totalNumber: 501 }]);
    const page = Number(new URL(url).searchParams.get('page'));
    return catalog(Array.from({ length: 100 }, (_, i) => episode((page - 1) * 100 + i + 1)), 501);
  })(req());
  const d = await r.json() as any;
  assert.equal(calls, 6); assert.equal(d.total, 500); assert.equal(d.complete, false); assert.deepEqual(d.missing_episode_numbers, [501]);
  assert.ok(d.warnings.includes('EPISODE_PAGE_LIMIT_REACHED'));
});
