import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { parseResourceResponse, resourceLink, RESOURCE_SOURCES } from '../src/resources';

const item = { vod_id: 105662, vod_name: '走马上任', type_name: '电视剧', vod_year: '2026',
  vod_remarks: '更新至07集', vod_play_from: 'qq$$$custom',
  vod_play_url: '第1集$https://v.qq.com/x/cover/mzc00200zsqz54y/v4102cvlyfo.html#第7集 SVIP抢先看$https://v.qq.com/x/cover/mzc00200zsqz54y/u4102l4hqji.html#第8集预告$https://v.qq.com/x/cover/mzc00200zsqz54y/trailer8.html$$$高清$https://cdn.example.com/video.m3u8#线路$https://parser.example.com/?url=video#危险$javascript:alert(1)' };
const payload = (items: unknown[] = [item], page = 1) => ({ code: 1, page, pagecount: 3, total: 80, list: items });
const json = (value: unknown) => new Response(JSON.stringify(value));

test('MacCMS JSON retains source identity, access-tier links, previews and URL types without calling a player', () => {
  const d = parseResourceResponse(JSON.stringify(payload()), 'jinchan');
  assert.equal(d.results.length, 1);
  assert.equal(d.results[0].source, 'third_party');
  assert.equal(d.results[0].detail_url, '/v1/resources/jinchan/items/105662');
  const [qq, other] = d.results[0].lines;
  assert.equal(qq.platform, 'tencent');
  assert.deepEqual(qq.episodes.map(e => e.episode_number), [1, 7]);
  assert.equal(qq.previews[0].episode_number, 8);
  assert.equal(qq.episodes[1].link_type, 'official_page');
  assert.equal(other.episodes.length, 2);
  assert.equal(other.episodes[0].link_type, 'media');
  assert.equal(other.episodes[1].link_type, 'external_page');
  assert.ok(other.episodes.every(e => !e.playback_verified && e.platform === null));
});

test('MacCMS XML supports RSS paging and CDATA playback groups, and rejects entity declarations and HTML', () => {
  const body = '<rss><list page="2" pagecount="4" recordcount="42"><video><id>88</id><name><![CDATA[走马上任]]></name><type>电视剧</type><year>2026</year><dl><dd flag="qq"><![CDATA[第1集$https://v.qq.com/x/cover/show/video.html#第2集预告$https://v.qq.com/x/cover/show/trailer.html]]></dd></dl></video></list></rss>';
  const r = parseResourceResponse(body, 'caiji8090');
  assert.equal(r.page, 2);
  assert.equal(r.total, 42);
  assert.equal(r.results[0].lines[0].episodes.length, 1);
  assert.equal(r.results[0].lines[0].previews.length, 1);
  for (const bad of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>', '<html><body>welcome</body></html>', '{"code":0,"list":[]}', '{"code":1,"list":{}}'])
    assert.throws(() => parseResourceResponse(bad, 'jinchan'));
});

test('resource routes validate source IDs, item IDs, auth, pagination and duplicates before any network call', async () => {
  let calls = 0;
  const h = createHandler(async () => { calls++; return json(payload()); });
  const metadata = await (await h(new Request('https://test/v1/resources'))).json() as any;
  assert.equal(metadata.sources.length, 7);
  assert.ok(metadata.sources.every((s: any) => s.source === 'third_party' && s.authorized === null));
  for (const path of ['/v1/resources/search?q=作品&sources=https://evil.test', '/v1/resources/search?q=作品&sources=',
    '/v1/resources/search?q=作品&page=0', '/v1/resources/search?q=作品&q=另一个',
    '/v1/resources/search?q=作品&url=https://evil.test', '/v1/resources/nope/items/1',
    '/v1/resources/jinchan/items/..%2Fsecret']) assert.equal((await h(new Request('https://test' + path))).status, 400, path);
  assert.equal((await h(new Request('https://test/v1/resources/search?q=作品'), { API_KEY: 'server-secret' })).status, 401);
  assert.equal(calls, 0);
});

test('search fans out only to selected fixed sources and reports per-source failures without borrowing website results', async () => {
  const calls: string[] = [];
  const h = createHandler(async (url, init) => {
    calls.push(url);
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.equal(new Headers(init?.headers).has('X-API-Key'), false);
    const u = new URL(url);
    assert.equal(u.searchParams.get('wd'), '走马上任');
    assert.equal(u.searchParams.get('pg'), '2');
    return url.startsWith(RESOURCE_SOURCES.jinchan.endpoint) ? json(payload([item], 2)) : new Response('<html>welcome</html>');
  });
  const r = await h(new Request('https://test/v1/resources/search?q=走马上任&sources=jinchan,caiji789,jinchan&page=2', { headers: { Authorization: 'Bearer server-secret' } }), { API_KEY: 'server-secret' });
  const d = await r.json() as any;
  assert.equal(r.status, 200);
  assert.equal(d.view, 'resources');
  assert.equal(d.partial, true);
  assert.equal(d.total, 1);
  assert.equal(calls.length, 2);
  assert.equal(d.providers[1].status, 'unavailable');
  assert.equal(d.providers[0].has_more, true);
});

test('a source ignoring wd retries its list search, then reports failure instead of passing unrelated feed results', async () => {
  for (const listWorks of [true, false]) {
    let calls = 0;
    const h = createHandler(async url => {
      calls++;
      return json(payload(new URL(url).searchParams.get('ac') === 'list' && listWorks ? [item] : [{ ...item, vod_name: '奶龙' }]));
    });
    const r = await h(new Request('https://test/v1/resources/search?q=走马上任&sources=jianan'));
    const d = await r.json() as any;
    assert.equal(calls, 2);
    assert.equal(r.status, listWorks ? 200 : 503);
    assert.equal(d.total, listWorks ? 1 : 0);
    if (!listWorks) assert.deepEqual(d.providers[0].warnings, ['RESOURCE_SEARCH_NOT_HONORED']);
  }
});

test('item detail uses exact source and ID, never fetches returned playback URLs, and enforces requested page', async () => {
  const calls: string[] = [];
  const h = createHandler(async url => { calls.push(url); return json(payload([item, { ...item, vod_id: 99 }])); });
  const d = await (await h(new Request('https://test/v1/resources/jinchan/items/105662'))).json() as any;
  assert.equal(d.item.id, '105662');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('ids'), '105662');
  const wrongPage = await h(new Request('https://test/v1/resources/search?q=走马上任&sources=jinchan&page=2'));
  assert.equal(wrongPage.status, 503);
  assert.equal((await (await h(new Request('https://test/v1/resources/jinchan/items/absent'))).json() as any).item, null);
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1/video', 'http://10.0.0.1/', 'http://[::1]/', 'https://user:pass@example.com/']) assert.equal(resourceLink(url), null);
});
