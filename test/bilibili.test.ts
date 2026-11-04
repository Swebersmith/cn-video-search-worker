import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { bilibiliSessionFetcher, bilibiliWbiQuery } from '../src/providers';

const img = '7cd084941338484aae1ad9425b84077c', sub = '4932caff0ff746eab6f01bf08b70ac45';
const nav = () => Response.json({code:-101,data:{wbi_img:{img_url:`https://i0.hdslb.com/bfs/wbi/${img}.png`,sub_url:`https://i0.hdslb.com/bfs/wbi/${sub}.png`}}});
const home = () => new Response('',{headers:{'Set-Cookie':'buvid3=issued-home-device; Domain=.bilibili.com; Path=/; HttpOnly'}});

test('WBI signature matches the documentation vector and encodes spaces and Chinese correctly', () => {
  assert.equal(bilibiliWbiQuery({foo:'114',bar:'514',zab:'1919810'},img,sub,1702204169000),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.match(bilibiliWbiQuery({keyword:"中 文!'()*"},img,sub,1702204169000),/^keyword=%E4%B8%AD%20%E6%96%87&wts=/);
  assert.throws(()=>bilibiliWbiQuery({},'missing',sub),/WBI_KEYS_UNAVAILABLE/);
});

test('Bilibili bootstraps once before parallel searches, shares WBI keys and includes only film/bangumi', async () => {
  let homes=0, navs=0; const types:string[]=[];
  const h = createHandler(async(url,init)=>{
    if(url==='https://www.bilibili.com/'){homes++;return home();}
    assert.equal(new Headers(init?.headers).get('Cookie'),'buvid3=issued-home-device');
    if(url.endsWith('/nav')){navs++;return nav();}
    const u=new URL(url);assert.equal(u.pathname,'/x/web-interface/wbi/search/type');
    assert.equal(homes,1);assert.ok(u.searchParams.get('w_rid'));assert.ok(u.searchParams.get('wts'));
    const type=u.searchParams.get('search_type')!;types.push(type);
    return Response.json({code:0,data:{result:[
      {type,season_id:type==='media_ft'?101:102,title:'同名剧',season_type_name:type==='media_ft'?'电影':'番剧'},
      {type:'video',season_id:999,title:'同名剧',season_type_name:'电影',bvid:'BVordinary'},
      {type:'bili_user',season_id:998,title:'同名剧',season_type_name:'电影'},
    ]}});
  });
  const r=await h(new Request('https://test/v1/bilibili/search?q=同名剧'));
  const d=await r.json() as any;assert.equal(r.status,200,JSON.stringify(d));
  assert.equal(homes,1);assert.equal(navs,1);assert.deepEqual(types.sort(),['media_bangumi','media_ft']);
  assert.deepEqual(d.results.map((v:any)=>v.id).sort(),['ss101','ss102']);
  assert.ok(d.results.every((v:any)=>v.url.startsWith('https://www.bilibili.com/bangumi/play/ss')));
});

test('Bilibili refreshes once for HTTP 200 JSON -412 and keeps cookies away from other services', async () => {
  let homes=0, searches=0;
  const f=bilibiliSessionFetcher({},async(url,init)=>{
    if(url==='https://www.bilibili.com/'){homes++;return new Response('',{headers:{'Set-Cookie':`buvid3=device-${homes}; Domain=.bilibili.com; Path=/`}});}
    if(url.includes('deepseek.com')){assert.equal(new Headers(init?.headers).get('Cookie'),null);return new Response('ok');}
    searches++;assert.equal(new Headers(init?.headers).get('Cookie'),`buvid3=device-${homes}`);
    return Response.json({code:-412});
  });
  assert.equal((await (await f('https://api.bilibili.com/x/web-interface/wbi/search/type')).json() as any).code,-412);
  assert.equal(homes,2);assert.equal(searches,2);
  await f('https://api.deepseek.com/chat/completions');
});

test('Bilibili all-search fallback discards video, creator and live groups even with season IDs', async () => {
  const h=createHandler(async(url)=>{
    if(url==='https://www.bilibili.com/')return home();
    if(url.endsWith('/nav'))return nav();
    if(new URL(url).pathname.endsWith('/type'))return Response.json({code:-400});
    assert.equal(new URL(url).pathname,'/x/web-interface/wbi/search/all/v2');
    return Response.json({code:0,data:{result:['video','bili_user','live','media_ft','media_bangumi'].map((type,i)=>({result_type:type,data:[{type,season_id:100+i,title:'同名剧',season_type_name:type==='media_ft'?'电影':'番剧'}]}))}});
  });
  const r=await h(new Request('https://test/v1/bilibili/search?q=同名剧'));
  const d=await r.json() as any;assert.equal(r.status,200,JSON.stringify(d));
  assert.deepEqual(d.results.map((v:any)=>v.id).sort(),['ss103','ss104']);
});
