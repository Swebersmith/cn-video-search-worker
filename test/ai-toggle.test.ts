import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import type { CacheStore, Fetcher } from '../src/types';
import { bilibiliSessionFetcher } from '../src/providers';

test('Bilibili catalogue shares only genuine anonymous session cookies and never leaks them to AI', async () => {
  let spi=0, retries=0;
  const f=bilibiliSessionFetcher({},async(url,init)=>{
    const headers=init?.headers as Record<string,string>;
    if(url.includes('/finger/spi')){spi++;return Response.json({code:0,data:{b_3:'official_buvid3',b_4:'official_buvid4'}});}
    if(url.includes('deepseek.com')){assert.equal(headers.Cookie,undefined);return new Response('ok');}
    if(!headers.Cookie)return new Response('',{status:412});
    assert.equal(headers.Cookie,'buvid3=official_buvid3; buvid4=official_buvid4');retries++;return new Response('ok');
  });
  const r=await Promise.all(['https://api.bilibili.com/season','https://api.bilibili.com/search'].map(u=>f(u)));
  assert.ok(r.every(r=>r.ok));assert.equal(spi,1);assert.equal(retries,2);
  await f('https://api.deepseek.com/chat/completions',{headers:{Authorization:'test-only'}});
});

test('request AI switch defaults to rules, prevents all AI calls when off, propagates to detail and isolates caches', async () => {
  let aiCalls = 0;
  const values = new Map<string, Response>();
  const cache: CacheStore = { match: async key => values.get(key.url)?.clone(), put: async (key, value) => { values.set(key.url, value.clone()); } };
  const fetcher: Fetcher = async url => {
    if (url.includes('deepseek.com')) {
      aiCalls++;
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{id:'123',category:'tv',confidence:1}]})}}]});
    }
    if (url.includes('mesh.if')) return Response.json({data:{templates:[{albumInfo:{qipuId:'123',title:'同名剧',channel:'电视剧,2',totalNumber:2,pageUrl:'https://www.iqiyi.com/v_ep1.html'}}]}});
    if (url.includes('pcw-api')) return Response.json({code:'A00000',data:{albumId:'123',total:2,epsodelist:[1,2].map(n=>({order:n,name:`第${n}集`,playUrl:`https://www.iqiyi.com/v_ep${n}.html`,contentType:1}))}});
    return new Response('client rendered player');
  };
  const h = createHandler(fetcher, cache), env = {DEEPSEEK_API_KEY:'configured-test-secret'};
  const query = 'https://test/v1/iqiyi/search?view=series&q=同名剧';
  const rules = await (await h(new Request(query), env)).json() as any;
  assert.equal(rules.ai_mode,'off'); assert.equal(aiCalls,0); assert.equal(rules.providers[0].ai.status,'disabled');
  assert.ok(rules.results[0].detail_url.endsWith('&ai=off'));
  const enabled = await (await h(new Request(query+'&ai=on'), env)).json() as any;
  assert.equal(enabled.ai_mode,'on'); assert.equal(aiCalls,1); assert.equal(enabled.providers[0].ai.status,'applied');
  assert.ok(enabled.results[0].detail_url.endsWith('&ai=on'));
  assert.deepEqual(rules.results.map((r:any)=>r.id),enabled.results.map((r:any)=>r.id));
  for (const mode of ['on','off']) {
    const d = await (await h(new Request(`https://test/v1/iqiyi/series/123?q=同名剧&ai=${mode}`), env)).json() as any;
    assert.equal(d.complete,true); assert.equal(d.main_total,2); assert.equal(d.ai_mode,mode);
  }
  const after = aiCalls;
  const again = await (await h(new Request(query+'&ai=off'), env)).json() as any;
  assert.equal(aiCalls,after); assert.equal(again.providers[0].ai.status,'disabled');
  assert.ok([...values.keys()].some(k=>k.includes('ai=off')));
  assert.ok([...values.keys()].some(k=>k.includes('ai=deepseek-flash')));
});

test('invalid or unsupported AI parameters fail before upstream I/O', async () => {
  let calls=0;const h=createHandler(async()=>{calls++;throw Error('unexpected upstream');});
  for(const path of ['/v1/search?q=剧&view=series&ai=true','/v1/iqiyi/series/123?q=剧&ai=no',
    '/v1/search?q=剧&ai=off','/v1/resources/search?q=剧&ai=on','/v1/search?q=剧&view=series&ai=on&ai=off']) {
    assert.equal((await h(new Request('https://test'+path))).status,400,path);
  }
  assert.equal(calls,0);
});

test('AI enabled without a key or with an upstream failure still returns rule-classified works', async () => {
  for(const configured of [false,true]) {
    let calls=0;
    const h=createHandler(async url=>{
      if(url.includes('deepseek.com')){calls++;return new Response('',{status:503});}
      return Response.json({data:{templates:[{albumInfo:{qipuId:'123',title:'正常作品',channel:'电视剧,2',totalNumber:40,pageUrl:'https://www.iqiyi.com/v_ep1.html'}},
        {albumInfo:{qipuId:'124',title:'短篇作品',channel:'电视剧,2',isMiniDrama:true,totalNumber:100,pageUrl:'https://www.iqiyi.com/v_short.html'}}]}});
    });
    const d=await(await h(new Request('https://test/v1/iqiyi/search?view=series&q=作品&ai=on'),configured?{DEEPSEEK_API_KEY:'test'}:{})).json() as any;
    assert.equal(d.total,1);assert.equal(d.results[0].category,'tv');assert.equal(calls,configured?1:0);
    assert.equal(d.providers[0].ai.status,configured?'fallback':'disabled');
  }
});
