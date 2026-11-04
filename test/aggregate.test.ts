import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { PLATFORMS, type Fetcher } from '../src/types';

const json = (value: unknown) => new Response(JSON.stringify(value));
const req = (path: string) => new Request('https://example.test' + path);
test('aggregate and single-site searches default to series and rules; removed official mode is rejected', async () => {
  const handler=createHandler(async()=>json({data:{templates:[{albumInfo:{qipuId:'123',title:'同名剧',channel:'电视剧,2',totalNumber:2,pageUrl:'https://www.iqiyi.com/v_first.html'}}]}}));
  for(const path of ['/v1/search?q=同名剧&platforms=iqiyi','/v1/iqiyi/search?q=同名剧']) {
    const implicit=await(await handler(req(path))).json() as any;
    const explicit=await(await handler(req(path+'&view=series'))).json() as any;
    assert.equal(implicit.view,'series');assert.equal(implicit.ai_mode,'off');
    assert.equal(implicit.results[0].content_type,'series');assert.deepEqual(implicit.results,explicit.results);
    assert.equal((await handler(req(path+'&view=official'))).status,400);
    assert.equal((await handler(req(path+'&page=1'))).status,400);
  }
  const metadata=await(await handler(req('/v1'))).json() as any;
  assert.equal(metadata.default_view,'series');
  const spec=await(await handler(req('/openapi.json'))).json() as any;
  assert.equal(spec.paths['/v1/search'].get.parameters.find((p:any)=>p.name==='view').schema.default,'series');
  assert.deepEqual(spec.paths['/v1/search'].get.parameters.find((p:any)=>p.name==='view').schema.enum,['series']);
  assert.ok(!spec.paths['/v1/search'].get.parameters.some((p:any)=>p.name==='page'));
  assert.ok(spec.paths['/v1/resources/search'].get.parameters.some((p:any)=>p.name==='page' && p.schema.maximum===1000));
  assert.equal(spec.components.schemas.OfficialResult,undefined);
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

test('removed compatibility routes, modes and album selector fail before I/O', async () => {
 let calls=0;const h=createHandler(async()=>{calls++;throw Error('unexpected');});
 for(const query of ['album_id=123','mode=all','mode=search','mode=episodes','view=videos','view=official','page=1'])assert.equal((await h(req('/v1/search?q=三体&'+query))).status,400);
 assert.equal((await h(req('/v1/episodes?q=三体'))).status,404);assert.equal(calls,0);
 const d=await(await h(req('/v1'))).json() as any;assert.deepEqual(d.views,['series']);
});
