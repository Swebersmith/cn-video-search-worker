import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { playbackCatalogue } from '../src/playback';
import { pageAssignment } from '../src/ssr-data';
import { createHandler } from '../src/index';
import { episodeCandidates } from '../src/episode-evidence';

const fixture = async (name: string) => JSON.parse(await readFile(`test/fixtures/${name}-play-data.json`, 'utf8'));
const script = (name: string, data: unknown) => `<script>${name}=${JSON.stringify(data)}</script>`;
const id = 'bcaa87c7834c46f99e7b';

test('real Youku player recovers the four finale premieres and badges missing from search, suppressing numbered trailers', async () => {
  const page = await fixture('youku');
  const items = page.moduleList[0].components[0].itemList;
  // A recommendations module containing another show is not part of the selected directory.
  page.moduleList[0].components.push({ type: 301, itemList: [{ ...items[0], title: '推荐外剧 第99集', stage: 99 }] });
  const h = createHandler(async url => {
    if (url.includes('v.youku.com/v_show/')) return new Response(script('window.__INITIAL_DATA__', page));
    if (url.includes('so.youku.com')) return new Response('challenge');
    if (new URL(url).searchParams.has('appScene')) return Response.json({ message: 'success', showId: id, isYouku: 1,
      updateNotice: '更新至26/30集', serisesList: items.slice(0, 26).map((e: any) => ({
        showId: id, videoId: e.action.value, orderId: e.stage, title: e.title,
      })) });
    return Response.json({ message: 'success', originNodes: [{ data: { showId: id, tempTitle: '嫁金钗', episodeTotal: 30, featureDTO: { text: '电视剧' } } }] });
  });
  const d = await (await h(new Request(`https://test/v1/youku/series/${id}?q=嫁金钗`))).json() as any;
  assert.equal(d.main_total, 30);
  assert.equal(d.total, 31);
  assert.equal(d.preview_total, 1);
  assert.equal(d.complete, true);
  assert.equal(d.expected_total, 30);
  assert.deepEqual(d.missing_episode_numbers, []);
  assert.deepEqual(d.unavailable_episode_numbers, []);
  assert.deepEqual(d.episodes.filter((e: any) => e.episode_number >= 27).map((e: any) => e.badges), Array.from({length:4}, () => ['收官礼']));
  assert.deepEqual(d.episodes.find((e: any) => e.episode_number === 25).badges, ['VIP']);
  assert.deepEqual(d.episodes.at(-1).badges, ['SVIP', '预告']);
  assert.equal(d.episodes.at(-1).episode_number, null);
  for (const field of ['previews','all_episodes','all_total']) assert.equal(field in d, false);
  assert.equal(new Set(d.episodes.map((e: any) => e.url)).size, d.total);
});

test('real Tencent and Mango player selections preserve ownership and native corner labels', async () => {
  const qq = await fixture('tencentmobile');
  const t = playbackCatalogue(script('window.__PINIA__', qq), 'tencent', 'mzc00200zsqz54y');
  assert.equal(t.candidates.length, 1);
  assert.match(t.candidates[0].url, /mzc00200zsqz54y\/v4102cvlyfo/);
  assert.throws(() => playbackCatalogue(script('window.__PINIA__', qq), 'tencent', 'foreign'), /ID_MISMATCH/);
  const mango = await fixture('mango');
  const m = playbackCatalogue(script('window.__NUXT__', mango), 'mango', '753011-22869999');
  assert.ok(m.candidates.length > 13);
  assert.ok(m.candidates.some(e => e.badges?.includes('VIP')));
  assert.ok(m.candidates.every(e => e.url.includes('/753011/')));
  assert.throws(() => playbackCatalogue(script('window.__NUXT__', mango), 'mango', '123-456'), /ID_MISMATCH/);
});

test('iQiyi and Bilibili page selections read only the exact album/season and retain paid and preview labels', () => {
  const iq = { albumId: '123', episodeList: [
    { order: 1, name: '第1集', playUrl: 'https://www.iqiyi.com/v_ep1.html', badge: '超前点映' },
    { order: 2, name: '第2集', playUrl: 'https://www.iqiyi.com/v_ep2.html', badge: '预告' },
  ] };
  const i = playbackCatalogue(script('window.__INITIAL_STATE__', { selected: iq, recommended: { ...iq, albumId: '999' } }), 'iqiyi', '123');
  assert.equal(i.candidates.length, 2);
  assert.deepEqual(i.candidates[0].badges, ['超前点映']);
  assert.equal(i.candidates[1].preview, true);
  const b = playbackCatalogue(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { season: {
    season_id: 123, episodes: [{ title: '1', link: 'https://www.bilibili.com/bangumi/play/ep1', badge: '会员' }],
  } } })}</script>`, 'bilibili', 'ss123');
  assert.equal(b.candidates.length, 1);
  assert.deepEqual(b.candidates[0].badges, ['会员']);
});

test('player data interpreter supports Nuxt shared data without executing arbitrary JavaScript', () => {
  const data = pageAssignment('<script>window.__NUXT__=(function(a){a.list=[{title:"选集"}];return {data:a}}({}))</script>', 'window.__NUXT__');
  assert.equal(data.data.list[0].title, '选集');
  for (const expression of ['fetch("https://evil.test")', '(function(a){a.__proto__={polluted:true};return a}({}))',
    '(function(a){a.constructor={};return a}({}))', '(function(){alert(1);return {}}())', 'new Function("alert(1)")()']) {
    assert.throws(() => pageAssignment(`<script>window.__NUXT__=${expression}</script>`, 'window.__NUXT__'), /SCHEMA_CHANGED/);
  }
  assert.equal(({} as any).polluted, undefined);
});

test('badges prefer current player labels, retain iQiyi VIP artwork identity, and ignore bottom dates', () => {
  const c = episodeCandidates({ cid: 'show123', vid: 'video123', title: '1',
    uni_imgtag: JSON.stringify({tag_2:{text:'VIP'}}), imgtag_all: JSON.stringify({tag_2:{text:'VIP-包月only-3.0'}}),
  }, 'tencent', 'show123', 'official');
  assert.deepEqual(c[0].badges, ['VIP']);
  const i = episodeCandidates({albumId:'123',order:1,name:'第1集',playUrl:'https://www.iqiyi.com/v_ep1.html',payMark:1,
    payMarkUrl:'http://pic0.iqiyipic.com/common/20171106/ac/1b/vip_100000_v_601.png'},'iqiyi','123','official');
  assert.deepEqual(i[0].badges,['VIP']);
  assert.deepEqual(episodeCandidates({albumId:'123',order:7,name:'演员专访',contentType:2,playUrl:'https://www.iqiyi.com/v_clip.html'},'iqiyi','123','official'),[]);
});
