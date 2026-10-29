import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Miniflare, Request, Response, convertV4MiniflareOptions } from 'miniflare';

test('workerd handles upstream fetch, response streams, auth and real Cache API', async () => {
  let outboundCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'cn-video-search-runtime-test', modules: true,
    scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-10-28',
    bindings: { API_KEY: 'runtime-test-secret' },
    outboundService: async (request: Request) => {
      outboundCalls++;
      assert.ok(request.url.startsWith('https://mesh.if.iqiyi.com/') || request.url.startsWith('https://pcw-api.iqiyi.com/'));
      const data = request.url.includes('pcw-api')
        ? { code: 'A00000', data: { albumId: '12345', total: 24, epsodelist: Array.from({ length: 24 }, (_, i) => ({ order: i + 1, name: `狂飙第${i + 1}集`, playUrl: `https://www.iqiyi.com/v_ep${i + 1}.html`, contentType: 1 })) } }
        : { data: { templates: [{ albumInfo: { title: '狂飙', pageUrl: 'https://www.iqiyi.com/v_xkt6z3z798.html', channel: '电视剧,2', qipuId: '12345', totalNumber: 24 } }] } };
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    assert.equal((await mf.dispatchFetch('https://example.test/health')).status, 200);
    const url = 'https://example.test/v1/search?q=%E7%8B%82%E9%A3%99&platforms=iqiyi';
    assert.equal((await mf.dispatchFetch(url)).status, 401);
    assert.equal(outboundCalls, 0);
    const headers = { Authorization: 'Bearer runtime-test-secret' };
    const first = await mf.dispatchFetch(url, { headers });
    const data = await first.json() as any;
    assert.equal(first.status, 200, JSON.stringify(data));
    assert.equal(data.results[0].url, 'https://www.iqiyi.com/v_xkt6z3z798.html');
    assert.equal(data.providers[0].cached, false);
    const second = await mf.dispatchFetch(url + '&limit=1', { headers });
    assert.equal((await second.json() as any).providers[0].cached, true);
    assert.equal(outboundCalls, 1);
    const episodeUrl = 'https://example.test/v1/episodes?q=%E7%8B%82%E9%A3%99';
    assert.equal((await mf.dispatchFetch(episodeUrl)).status, 401);
    const episodes = await (await mf.dispatchFetch(episodeUrl, { headers })).json() as any;
    assert.equal(episodes.total, 24); assert.equal(episodes.complete, true);
    assert.deepEqual(episodes.results.map((e: any) => e.episode_number), Array.from({ length: 24 }, (_, i) => i + 1));
    assert.equal((await (await mf.dispatchFetch(episodeUrl, { headers })).json() as any).cached, true);
    assert.equal(outboundCalls, 3);
  } finally { await mf.dispose(); }
});
