import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../src/index';
import { episodeCandidates } from '../src/episode-evidence';
import type { Fetcher } from '../src/types';

const id = 'mzc00200zsqz54y';
const json = (v: unknown) => new Response(JSON.stringify(v));
const fixture = async () => JSON.parse(await readFile('test/fixtures/tencent-zoushangren.json', 'utf8'));
const path = `/v1/tencent/series/${id}?q=走马上任`;
const search = (total: number, firstUrl: string) => ({ ret: 0, data: { normalList: [{ videoInfo: {
  title: '走马上任', typeName: '电视剧', episodeSites: [{ totalEpisode: total,
    episodeInfoList: [{ title: '1', url: firstUrl }] }],
} }] } });
function upstream(data: unknown, total: number, model?: Fetcher): Fetcher {
  return async (url, init) => {
    if (url.includes('deepseek')) {
      if (model) return model(url, init);
      throw Error('AI must not be needed for explicit trailer evidence');
    }
    return json(url.includes('GetPageData') ? data : search(total, episodeCandidates(data, 'tencent', id, 'fixture')[0].url));
  };
}
const modelResponse = (v: unknown) => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(v) } }] });

test('real Tencent 走马上任 payload yields five unique mains and six previews, including unreleased 6/7', async () => {
  const h = createHandler(upstream(await fixture(), 11));
  const d = await (await h(new Request('https://test' + path))).json() as any;
  assert.deepEqual(d.episodes.map((e: any) => e.episode_number), [1, 2, 3, 4, 5]);
  assert.equal(d.main_total, 5);
  assert.equal(d.total, 5);
  assert.equal(d.previews.length, 6);
  assert.equal(d.expected_total, 7);
  assert.deepEqual(d.unavailable_episode_numbers, [6, 7]);
  assert.deepEqual(d.missing_episode_numbers, []);
  assert.equal(d.complete, false);
  assert.equal(d.ai.status, 'not_needed');
  assert.ok(!d.warnings.includes('CONFLICTING_EPISODE_NUMBERS'));
  assert.ok(d.episodes.every((e: any) => !/预告/.test(e.title)));
  assert.ok(d.previews.every((e: any) => !d.episodes.some((m: any) => m.url === e.url)));
});

test('Tencent evidence reads string trailer flags, full titles, JSON badges and exact cover ownership', () => {
  for (const evidence of [{ is_trailer: '1' }, { play_title: '02集预告' },
    { uni_imgtag: JSON.stringify({ tag_2: { text: '预告' } }) }]) {
    const c = episodeCandidates({ cid: id, vid: 'testvid', title: '2', ...evidence }, 'tencent', id, 'official');
    assert.equal(c.length, 1);
    assert.equal(c[0].preview, true);
    assert.equal(c[0].number_hint, 2);
  }
  assert.deepEqual(episodeCandidates({ cid: 'foreign', vid: 'testvid', title: '2' }, 'tencent', id, 'official'), []);
  const c = episodeCandidates({ chapterName: '预告', items: [{ title: '02集', url: 'https://v.youku.com/v_show/id_Xtest.html' }] }, 'youku', 'show101abc', 'official');
  assert.equal(c[0].preview, true);
});

const ambiguousData = () => ({ ret: 0, data: { has_next_page: false, module_list_datas: [{ items:
  ['realvideo', 'ambiguousvideo'].map((vid) => ({ item_params: { cid: id, vid, title: '1',
    play_title: '走马上任 第1集', duration: vid === 'realvideo' ? '2000' : '200' } })),
}] } });

test('AI cannot invent a hidden preview from duration or duplicate episode numbers', async () => {
  let audits = 0;
  const h = createHandler(upstream(ambiguousData(), 2, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages[1].content);
    if (input.items) return modelResponse({ items: [{ id, category: 'tv', confidence: 1 }] });
    audits++;
    assert.equal(input.mode, 'audit');
    assert.equal(input.candidates.length, 2);
    assert.deepEqual(input.candidates.map((c: any) => c.duration_seconds), [2000, 200]);
    assert.ok(!JSON.stringify(input).includes('https://'));
    return modelResponse({ episodes: input.candidates.map((c: any, i: number) => ({ candidate_ref: c.ref,
      episode_number: 1, episode_type: i === 0 ? 'main' : 'preview', confidence: 0.99 })) });
  }));
  const d = await (await h(new Request('https://test' + path), { DEEPSEEK_API_KEY: 'test' })).json() as any;
  assert.equal(audits, 1);
  assert.equal(d.main_total, 2);
  assert.ok(d.episodes.some((e: any) => /realvideo/.test(e.url)));
  assert.equal(d.previews.length, 0);
  assert.equal(d.ai.classified, 1);
  assert.equal(d.ai.recovered, 0);
});

test('SVIP, early access, paid premieres and trial access are mains even for short videos or other sections', async () => {
  const labels = ['VIP', 'SVIP', '提前看', '抢先看', '超前点映', '会员试看'];
  const items = labels.map((label, i) => ({ item_params: { cid: id, vid: `premium${i}`, title: String(i + 1),
    play_title: `走马上任 第${i + 1}集`, c_title_output: label, is_trailer: '0',
    duration: '90', section_type: 1, uni_imgtag: JSON.stringify({ tag_2: { text: label } }) } }));
  items.push({ item_params: { ...items[0].item_params, vid: 'explicittrailer', is_trailer: '1' } });
  const data = { ret: 0, data: { has_next_page: false, module_list_datas: [{ items }] } };
  const d = await (await createHandler(upstream(data, 7))(new Request('https://test' + path))).json() as any;
  assert.deepEqual(d.episodes.map((e: any) => e.episode_number), [1, 2, 3, 4, 5, 6]);
  assert.equal(d.previews.length, 1);
  assert.equal(d.all_total, 7);
  assert.equal(d.all_episodes.length, 7);
  assert.equal(new Set(d.all_episodes.map((e: any) => e.url)).size, 7);
  for (let i = 0; i < 6; i++) assert.ok(d.episodes.some((e: any) => e.url.includes(`premium${i}`)));
});

test('official numbered URLs beyond AI candidate limits and stale expected totals are never truncated', async () => {
  const items = Array.from({ length: 70 }, (_, i) => ({ item_params: { cid: id, vid: `vipvideo${i}`, title: String(i + 1),
    play_title: `第${i + 1}集 SVIP`, is_trailer: '0' } }));
  const data = { ret: 0, data: { has_next_page: false, module_list_datas: [{ items }] } };
  const d = await (await createHandler(upstream(data, 5))(new Request('https://test' + path))).json() as any;
  assert.equal(d.main_total, 70);
  assert.equal(d.previews.length, 0);
  assert.equal(d.episodes.at(-1).episode_number, 70);
});

test('all official main URLs remain available on missing, failed or inconclusive AI', async () => {
  for (const mode of ['disabled', 'failed', 'partial', 'both-main']) {
    const h = createHandler(upstream(ambiguousData(), 2, async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (input.items) return modelResponse({ items: [{ id, category: 'tv', confidence: 1 }] });
      if (mode === 'failed') return new Response('', { status: 503 });
      return modelResponse({ episodes: mode === 'partial' ? [] : input.candidates.map((c: any) => ({
        candidate_ref: c.ref, episode_number: 1, episode_type: 'main', confidence: 1,
      })) });
    }));
    const d = await (await h(new Request('https://test' + path), mode === 'disabled' ? {} : { DEEPSEEK_API_KEY: 'test' })).json() as any;
    assert.equal(d.main_total, 2, mode);
    assert.equal(d.complete, false, mode);
    assert.ok(d.warnings.includes('CONFLICTING_EPISODE_NUMBERS'), mode);
  }
});
