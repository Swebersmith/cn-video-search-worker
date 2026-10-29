import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Miniflare, Request, Response, convertV4MiniflareOptions } from 'miniflare';

test('workerd handles upstream fetch, response streams, auth and real Cache API', async () => {
  let outboundCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'cn-video-search-runtime-test', modules: true,
    scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-10-28',
    bindings: { API_KEY: 'runtime-test-secret', DEEPSEEK_API_KEY: 'runtime-ai-secret' },
    outboundService: async (request: Request) => {
      outboundCalls++;
      if(request.url==='https://api.deepseek.com/chat/completions'){assert.equal(request.headers.get('Authorization'),'Bearer runtime-ai-secret');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{id:'12345',category:'tv',confidence:1}]})}}]}));}
      if(request.url.startsWith('https://search.bilibili.com/all?'))return new Response('<script>window.__pinia=(function(a){return {searchResponse:{searchAllResponse:{page:1,numPages:2,result:[{result_type:"video",data:[{title:a,arcurl:"https://www.bilibili.com/video/BV123"}]}]}}}}("官网投稿"))</script>');
      assert.ok(request.url.startsWith('https://mesh.if.iqiyi.com/') || request.url.startsWith('https://pcw-api.iqiyi.com/'));
      const data = request.url.includes('pcw-api')
        ? { code: 'A00000', data: { albumId: '12345', total: 24, epsodelist: Array.from({ length: 24 }, (_, i) => ({ order: i + 1, name: `狂飙第${i + 1}集`, playUrl: `https://www.iqiyi.com/v_ep${i + 1}.html`, contentType: 1 })) } }
        : { data: { templates: [{ albumInfo: { title: '狂飙', pageUrl: 'https://www.iqiyi.com/v_xkt6z3z798.html', channel: '电视剧,2', qipuId: '12345', totalNumber: 24 } }] } };
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    assert.equal((await mf.dispatchFetch('https://example.test/health')).status, 200);
    const headers = { Authorization: 'Bearer runtime-test-secret' };
    const discovery = await (await mf.dispatchFetch('https://example.test/v1/iqiyi/search?view=series&q=%E7%8B%82%E9%A3%99', { headers })).json() as any;
    assert.equal(discovery.providers[0].ai.status,'applied');
    assert.equal(discovery.view, 'series'); assert.equal(discovery.total, 1); assert.equal(discovery.results[0].id, '12345');
    const detailUrl = 'https://example.test' + discovery.results[0].detail_url;
    assert.equal((await mf.dispatchFetch(detailUrl)).status, 401);
    const detail = await (await mf.dispatchFetch(detailUrl, { headers })).json() as any;
    assert.equal(detail.complete, true); assert.equal(detail.total, 24); assert.equal(detail.main_total, 24);
    const usedCalls = outboundCalls;
    assert.equal((await (await mf.dispatchFetch(detailUrl, { headers })).json() as any).cached, true); assert.equal(outboundCalls, usedCalls);
    const docs = await mf.dispatchFetch('https://example.test/');
    assert.equal(docs.status, 200); assert.match(await docs.text(), /总接口与单站接口/);
    assert.equal((await mf.dispatchFetch('https://example.test/assets/docs.js')).status, 200);
    const officialUrl='https://example.test/v1/iqiyi/search?q=%E7%8B%82%E9%A3%99';
    assert.equal((await mf.dispatchFetch('https://example.test/v1/episodes?q=狂飙')).status,404);
    const beforeOfficial=outboundCalls;
    for(let i=0;i<2;i++) {
      const official=await (await mf.dispatchFetch(officialUrl,{headers})).json() as any;
      assert.equal(official.view,'official');
      assert.equal(official.providers[0].upstream.data.templates[0].albumInfo.title,'狂飙');
      assert.equal(official.providers[0].cached,false);
    }
    assert.equal(outboundCalls,beforeOfficial+2);
    const bili=await (await mf.dispatchFetch('https://example.test/v1/bilibili/search?q=三体',{headers})).json() as any;
    assert.equal(bili.results[0].title,'官网投稿');
    assert.ok(bili.providers[0].source_url.startsWith('https://search.bilibili.com/all?'));
    assert.equal(bili.providers[0].upstream.data.page,1);
  } finally { await mf.dispose(); }
});
