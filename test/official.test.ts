import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createHandler } from '../src/index';
import { mangoSearchUrl } from '../src/providers';
import { officialLink } from '../src/official';
import type { Platform, Fetcher } from '../src/types';

const json = (data: unknown) => new Response(JSON.stringify(data));
const data: Record<Platform, any> = {
  iqiyi:{data:{templates:[{template:101,albumInfo:{title:'纪录片',channel:'纪录片,3',pageUrl:'https://www.iqiyi.com/a_doc.html'}},{template:108,albumInfo:{title:'UP主视频',pageUrl:'https://www.iqiyi.com/v_ugc.html'}},{template:999,unknown:'new card'}],pageSize:20,resultNum:90}},
  tencent:{ret:0,data:{normalList:{hasMore:true,itemList:[{videoInfo:{title:'别站收录电影',playSites:[{url:'https://www.iqiyi.com/v_movie.html'}]}},{type:'creator',title:'创作者',url:'https://v.qq.com/creator/abc'}]}}},
  youku:{message:'success',more:true,pageData:{total:80},pageComponentList:[{commonData:{titleDTO:{displayName:'官网排第一'},isYouku:0,leftButtonDTO:{action:{value:'https://www.iqiyi.com/v_other.html'}}}},{commonData:{title:'重复卡片'}},{commonData:{title:'重复卡片'}}]},
  mango:{code:200,data:{totalHits:99,hasMore:true,contents:[{type:'preview',data:{title:'花絮',url:'//www.mgtv.com/b/1/2.html'}},{type:'artist',data:{title:'歌手',url:'//www.mgtv.com/star/123'}}]}},
  bilibili:{code:0,data:{page:2,numResults:100,numPages:5,result:[{result_type:'media_bangumi',data:[{title:'番剧'}]},{result_type:'video',data:[{title:'普通投稿',arcurl:'https://www.bilibili.com/video/BV123'}]},{result_type:'bili_user',data:[{uname:'作者',url:'https://space.bilibili.com/123'}]},{result_type:'future_type',data:[{arbitrary:'keep me'}]}]}},
};
test('default official search preserves every category, duplicate, unranked and unknown native card, with paging', async () => {
  const calls: string[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push(url);
    if (url.includes('mesh.if')) {assert.equal(new URL(url).searchParams.get('pageNum'),'2');return json(data.iqiyi);}
    if (url.includes('MbSearch')) {assert.equal(JSON.parse(String(init?.body)).pagenum,1);return json(data.tencent);}
    if (url.includes('search.youku.com')) {assert.equal(new URL(url).searchParams.get('pg'),'2');return json(data.youku);}
    if (url.includes('mobileso')) {assert.equal(new URL(url).searchParams.get('pn'),'2');assert.ok(new URL(url).searchParams.get('signature'));return json(data.mango);}
    assert.ok(url.startsWith('https://api.bilibili.com/x/web-interface/search/all/v2?'));
    assert.equal(new URL(url).searchParams.get('page'),'2');
    assert.equal(new URL(url).searchParams.get('platform'),'pc');
    assert.equal(new URL(url).searchParams.get('page_size'),'42');
    return json(data.bilibili);
  };
  const r = await createHandler(f)(new Request('https://test/v1/search?q=不相关关键词&page=2&limit=1'));
  const d = await r.json() as any;
  assert.equal(r.status,200);
  assert.equal(d.view,'official');
  assert.equal(d.source_policy,'same_platform_official_only');
  assert.equal(d.total,14);
  assert.equal(d.partial,false);
  assert.equal(calls.length,5);
  for (const p of d.providers) {
    if(p.platform==='bilibili')assert.deepEqual(p.upstream.data,data.bilibili.data);else assert.deepEqual(p.upstream,data[p.platform as Platform]);
    const items = d.results.filter((x:any)=>x.platform===p.platform);
    assert.deepEqual(items.map((x:any)=>x.rank),Array.from({length:items.length},(_,i)=>i+1));
  }
  assert.deepEqual(d.results.filter((x:any)=>x.platform==='youku').map((x:any)=>x.title),['官网排第一','重复卡片','重复卡片']);
  assert.ok(d.results.some((x:any)=>x.type_name==='video' && x.title==='普通投稿'));
  assert.ok(d.results.some((x:any)=>x.type_name==='future_type' && x.raw.arbitrary==='keep me'));
});

test('Mango checksum follows the public website serializer and is computed from actual request params', () => {
  const u = new URL(mangoSearchUrl('空 格&中文',2,new Date('2026-10-29T00:00:00Z'),'a-b-c'));
  assert.equal(u.pathname,'/pc/search/v2');
  assert.equal(u.searchParams.get('q'),'空 格&中文');
  const params = [...u.searchParams.entries()].filter(([k])=>k!=='signature').sort(([a],[b])=>a.localeCompare(b));
  const sorted=params.map(([k,v])=>encodeURI(k)+'='+encodeURI(v)).join('&');
  assert.equal(u.searchParams.get('signature'),createHash('md5').update('xHAa3YZflWLogZUOzl'+sorted+'xHAa3YZflWLogZUOzl').digest('hex'));
});

test('Tencent areaBoxIndex follows official layout references rather than dropping its actual cards', async () => {
  const payload={ret:0,data:{normalList:{itemList:[{doc:{areaBoxIndex:[0]}},{staticRelateSearchWord:{relateWordList:['推荐词']}}]},areaBoxList:[{itemList:[{videoInfo:{title:'官网第一部电影'}},{videoInfo:{title:'官网第二部电视剧'}}]}]}};
  const r=await createHandler(async()=>json(payload))(new Request('https://test/v1/tencent/search?q=影片'));
  const d=await r.json() as any;
  assert.deepEqual(d.results.map((x:any)=>x.title),['官网第一部电影','官网第二部电视剧','相关搜索']);
  assert.deepEqual(d.providers[0].upstream,payload);
});

test('official failures never borrow results from another platform or a third-party search service', async () => {
  const calls: string[] = [];
  const h=createHandler(async url=>{calls.push(url);return new Response('',{status:412});});
  const r=await h(new Request('https://test/v1/mango/search?q=三体'));
  assert.equal(r.status,503);
  const d=await r.json() as any;
  assert.deepEqual(d.results,[]);
  assert.ok(calls.every(url=>new URL(url).hostname==='mobileso.bz.mgtv.com'));
  assert.deepEqual(d.providers[0].warnings,['HTTP_412']);
});

test('Bilibili can initialize a genuine anonymous website session after 412 without inventing cookies', async () => {
  let count=0;
  const h=createHandler(async (url,init)=>{
    if(new URL(url).hostname==='search.bilibili.com')return new Response('',{status:412});
    assert.equal(new URL(url).hostname,'api.bilibili.com');
    if(url.includes('/finger/spi'))return json({code:0,data:{b_3:'official-buvid-3',b_4:'official-buvid-4'}});
    if(++count===1)return new Response('',{status:412});
    assert.equal((init?.headers as Record<string,string>).Cookie,'buvid3=official-buvid-3; buvid4=official-buvid-4');
    return json(data.bilibili);
  });
  const d=await (await h(new Request('https://test/v1/bilibili/search?q=三体'))).json() as any;
  assert.equal(d.results.length,4);
  assert.deepEqual(d.providers[0].warnings,['ssr:HTTP_412','initial:HTTP_412']);
});

test('official page validation and URL allowlist protect native card rendering', async () => {
  let calls=0;
  const h=createHandler(async()=>{calls++;return json({});});
  for(const args of ['page=0','page=1.5','page=1001','page=2&page=3','view=series&page=2','view=official&mode=all'])
    assert.equal((await h(new Request('https://test/v1/search?q=三体&'+args))).status,400);
  assert.equal(calls,0);
  for(const link of ['javascript:alert(1)','https://evil.com/','https://bilibili.com.evil.com/','https://x:pw@v.qq.com/']) assert.equal(officialLink(link,'bilibili'),null);
  assert.equal(officialLink('https://space.bilibili.com/123','bilibili'),'https://space.bilibili.com/123');
});
