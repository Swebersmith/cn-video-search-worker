import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { Miniflare, Request, Response, convertV4MiniflareOptions } from 'miniflare';

test('workerd handles upstream fetch, response streams, auth and real Cache API', async () => {
  let outboundCalls = 0, aiCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'cn-video-search-runtime-test', modules: true,
    scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-10-28',
    bindings: { API_KEY: 'runtime-test-secret', DEEPSEEK_API_KEY: 'runtime-ai-secret' },
    kvNamespaces: ['RESOURCE_CONFIG'],
    outboundService: async (request: Request) => {
      outboundCalls++;
      if(request.url.startsWith('https://zy.jinchanjiexi.net/')){
        assert.equal(request.headers.get('Authorization'),null);
        return new Response(JSON.stringify({code:1,page:1,pagecount:1,total:1,list:[{vod_id:105662,vod_name:'走马上任',vod_play_from:'qq',vod_play_url:'第7集 SVIP$https://v.qq.com/x/cover/show/video.html#第8集预告$https://v.qq.com/x/cover/show/trailer.html'}]}));
      }
      if(request.url.startsWith('https://xml.public-site.com/'))return new Response('<rss><list page="1" pagecount="1" recordcount="1"><video><id>88</id><name>走马上任</name><dl><dd flag="qq"><![CDATA[第1集$https://v.qq.com/x/cover/show/video.html]]></dd></dl></video></list></rss>');
      if(request.url==='https://api.deepseek.com/chat/completions'){aiCalls++;assert.equal(request.headers.get('Authorization'),'Bearer runtime-ai-secret');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{id:'12345',category:'tv',confidence:1}]})}}]}));}
      if(request.url.startsWith('https://search.bilibili.com/all?'))return new Response('<script>window.__pinia=(function(a){return {searchResponse:{searchAllResponse:{page:1,numPages:2,result:[{result_type:"video",data:[{title:a,arcurl:"https://www.bilibili.com/video/BV123"}]}]}}}}("官网投稿"))</script>');
      assert.ok(request.url.startsWith('https://mesh.if.iqiyi.com/') || request.url.startsWith('https://pcw-api.iqiyi.com/'));
      const data = request.url.includes('pcw-api')
        ? { code: 'A00000', data: { albumId: '12345', total: 24, epsodelist: Array.from({ length: 24 }, (_, i) => ({ order: i + 1, name: `狂飙第${i + 1}集`, playUrl: `https://www.iqiyi.com/v_ep${i + 1}.html`, contentType: 1 })) } }
        : { data: { templates: [{ albumInfo: { title: '狂飙', pageUrl: 'https://www.iqiyi.com/v_xkt6z3z798.html', channel: '电视剧,2', qipuId: '12345', totalNumber: 24 } }] } };
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const config = await mf.getKVNamespace('RESOURCE_CONFIG');
    await config.put('resource-sources:v1', JSON.stringify({version:1,revision:'runtime-test',updated_at:new Date().toISOString(),sources:[
      {id:'jinchan',name:'金蝉官采',endpoint:'https://zy.jinchanjiexi.net/api.php/provide/vod/',enabled:true},
      {id:'caiji8090',name:'8090官采',endpoint:'https://xml.public-site.com/api.php/provide/vod/at/xml/',enabled:true},
    ]}));
    assert.equal((await mf.dispatchFetch('https://example.test/health')).status, 200);
    const headers = { Authorization: 'Bearer runtime-test-secret' };
    const discovery = await (await mf.dispatchFetch('https://example.test/v1/iqiyi/search?view=series&ai=on&q=%E7%8B%82%E9%A3%99', { headers })).json() as any;
    assert.equal(discovery.providers[0].ai.status,'applied');
    assert.equal(discovery.view, 'series'); assert.equal(discovery.total, 1); assert.equal(discovery.results[0].id, '12345');
    const detailUrl = 'https://example.test' + discovery.results[0].detail_url;
    assert.equal((await mf.dispatchFetch(detailUrl)).status, 401);
    const detail = await (await mf.dispatchFetch(detailUrl, { headers })).json() as any;
    assert.equal(detail.complete, true); assert.equal(detail.total, 24); assert.equal(detail.main_total, 24);
    const usedCalls = outboundCalls;
    assert.equal((await (await mf.dispatchFetch(detailUrl, { headers })).json() as any).cached, true); assert.equal(outboundCalls, usedCalls);
    const beforeRules = aiCalls;
    const rules = await(await mf.dispatchFetch('https://example.test/v1/iqiyi/search?view=series&ai=off&q=狂飙',{headers})).json() as any;
    assert.equal(rules.ai_mode,'off');assert.equal(rules.providers[0].ai.status,'disabled');assert.equal(aiCalls,beforeRules);
    assert.ok(rules.results[0].detail_url.endsWith('&ai=off'));
    const ruleDetail=await(await mf.dispatchFetch('https://example.test'+rules.results[0].detail_url,{headers})).json() as any;
    assert.equal(ruleDetail.main_total,24);assert.equal(ruleDetail.complete,true);assert.equal(aiCalls,beforeRules);
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
    const resources=await(await mf.dispatchFetch('https://example.test/v1/resources/search?q=走马上任&sources=jinchan,caiji8090',{headers})).json() as any;
    assert.equal(resources.view,'resources',JSON.stringify(resources));assert.equal(resources.total,2);assert.equal(resources.partial,false);
    assert.equal(resources.results[0].lines[0].episodes[0].episode_number,7);
    assert.equal(resources.results[0].lines[0].previews.length,1);
    assert.equal(resources.results[1].id,'88');
    assert.equal((await mf.dispatchFetch('https://example.test/v1/resources/jinchan/items/105662')).status,401);
    const resourceDetail=await(await mf.dispatchFetch('https://example.test/v1/resources/jinchan/items/105662',{headers})).json() as any;
    assert.equal(resourceDetail.item.id,'105662');
  } finally { await mf.dispose(); }
});
