import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, ranked, score, video } from '../src/normalize';
import { request, UpstreamError } from '../src/providers';
import { createHandler } from '../src/index';
import type { Fetcher } from '../src/types';
const failing: Fetcher = async () => new Response('', {status:403});
test('official playback allowlist rejects lookalikes, credentials, media and non-playback pages', () => {
  for (const u of ['https://v.qq.com.evil.test/x/page/a.html', 'javascript:alert(1)', 'https://v.qq.com@evil.test/x/page/a.html', 'https://v.qq.com/x/search/?q=三体', 'https://v.qq.com/a.m3u8', 'https://v.qq.com:8443/x/page/a.html']) assert.equal(canonical(u, 'tencent'), undefined);
  assert.equal(canonical('https://www.iqiyi.com/a_abcd.html', 'iqiyi'), undefined);
  assert.equal(canonical('https://v.youku.com/video?vid=Xabc==&spm=tracking', 'youku')?.url, 'https://v.youku.com/v_show/id_Xabc==.html');
  assert.equal(canonical('http://v.qq.com/x/cover/abc.html?tracking=1', 'tencent')?.kind, 'series');
  assert.equal(canonical('https://www.bilibili.com/bangumi/play/ep1?from=search', 'bilibili')?.url, 'https://www.bilibili.com/bangumi/play/ep1');
});
test('fuzzy ranking favors exact and partial names, removes irrelevant and duplicate URLs', () => {
  assert.equal(score('三体', '三体'), 1);
  assert.ok(score('三体', '我的三体') > score('三体', '三国演义'));
  const a = video('iqiyi', '三体', '三体', 'https://www.iqiyi.com/v_a.html')!;
  const b = video('iqiyi', '三体', '我的三体', 'https://www.iqiyi.com/v_b.html')!;
  assert.deepEqual(ranked([b, a, a]).map(x => x.title), ['三体', '我的三体']);
});
test('upstream body limits and deadlines terminate requests', async () => {
  await assert.rejects(request('https://example.test', {}, async () => new Response('', { headers: { 'Content-Length': '9999999' } })), /RESPONSE_TOO_LARGE/);
  const pending: Fetcher = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(request('https://example.test', { UPSTREAM_TIMEOUT_MS: '1000' }, pending), (e: unknown) => e instanceof UpstreamError && e.message === 'TIMEOUT');
});
test('health, OpenAPI and preflight are available without upstream or API key', async () => {
  const handler = createHandler(failing);
  for (const path of ['/health', '/openapi.json', '/v1/platforms']) assert.equal((await handler(new Request(`https://example.test${path}`), { API_KEY: 'secret' })).status, 200);
  assert.equal((await handler(new Request('https://example.test/v1/search', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handler(new Request('https://example.test/v1/search', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('https://example.test/missing'))).status, 404);
});
