import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { PLATFORMS, type Fetcher } from '../src/types';

const json = (value: unknown) => new Response(JSON.stringify(value));
const req = (path: string) => new Request('https://example.test' + path);
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
 for(const query of ['album_id=123','mode=all','mode=search','mode=episodes','view=videos'])assert.equal((await h(req('/v1/search?q=三体&'+query))).status,400);
 assert.equal((await h(req('/v1/episodes?q=三体'))).status,404);assert.equal(calls,0);
 const d=await(await h(req('/v1'))).json() as any;assert.deepEqual(d.views,['official','series']);
});
