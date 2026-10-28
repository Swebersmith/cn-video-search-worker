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
      assert.ok(request.url.startsWith('https://mesh.if.iqiyi.com/'));
      return new Response(JSON.stringify({ data: { templates: [{ albumInfo: { title: '狂飙', pageUrl: 'https://www.iqiyi.com/v_xkt6z3z798.html' } }] } }), { headers: { 'Content-Type': 'application/json' } });
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
  } finally { await mf.dispose(); }
});
