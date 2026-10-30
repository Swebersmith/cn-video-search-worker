import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index';
import { embeddedJson } from '../src/catalogue';
import { type CacheStore, type Fetcher, type Platform, PLATFORMS } from '../src/types';
import { readFile } from 'node:fs/promises';

test('Youku nullable chapter labels retain published episodes and inline previews and do not invent future gaps', async () => {
  for (const [id, title, planned, available, released] of [
    ['bcaa87c7834c46f99e7b', '嫁金钗', 30, 21, 22],
  ] as const) {
    const full = JSON.parse(await readFile(`test/fixtures/youku-${id}.json`, 'utf8'));
    const handler = createHandler(async (url) => {
      if (url.includes('so.youku.com')) return new Response('verification');
      if (new URL(url).searchParams.get('appScene') === 'show_episode') return json(full);
      return json({message:'success',originNodes:[{data:{showId:id,tempTitle:title,episodeTotal:planned,featureDTO:{text:"电视剧"}}}]});
    });
    const response = await handler(request(`/v1/youku/series/${id}?q=${encodeURIComponent(title)}`));
    const d = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(d.total, 23);
    assert.equal(d.main_total, available);
    assert.equal(d.preview_total,2);
    assert.equal(d.extra_total,0);
    assert.equal(d.expected_total, released);
    assert.equal(d.series.total_episodes, planned);
    assert.equal(d.update_notice, full.updateNotice);
    assert.equal(d.complete, Number(available) === released);
    assert.deepEqual(d.missing_episode_numbers, []);
    assert.deepEqual(d.unavailable_episode_numbers,[22]);
    assert.ok(d.previews.some((e:any)=>e.episode_number===22));
    assert.ok(d.episodes.filter((e:any)=>e.episode_type==='main').every((e: any) => e.episode_number && e.episode_number <= available));
    assert.deepEqual(d.episodes.map((e:any)=>e.episode_number),Array.from({length:23},(_,i)=>i+1));
    assert.deepEqual(d.episodes.slice(-2).map((e:any)=>e.episode_type),['preview','preview']);
    assert.equal(new Set(d.episodes.map((e:any)=>e.url)).size,d.total);
  }
});

test('Youku labelled bonus episodes remain separate from the numbered main series', async () => {
  const full = JSON.parse(await readFile('test/fixtures/youku-extra-api.json', 'utf8'));
  const h = createHandler(async url => url.includes('so.youku.com') ? new Response('verification')
    : json(new URL(url).searchParams.has('appScene') ? full : {message:'success',originNodes:[{data:{showId:full.showId,tempTitle:'长安二十四计',episodeTotal:28,featureDTO:{text:'电视剧'}}}]}));
  const d = await (await h(request(`/v1/youku/series/${full.showId}?q=长安二十四计`))).json() as any;
  assert.equal(d.complete, true);
  assert.equal(d.main_total, 28);
  assert.equal(d.extra_total, 1);
  assert.equal(d.expected_total, 29);
  assert.equal(d.episodes[28].episode_type, 'extra');
  assert.equal(d.episodes[28].episode_number, null);
});

test('Youku nullable chapters still reject wrong shows, extras and gaps in the released range', async () => {
  const full = JSON.parse(await readFile('test/fixtures/youku-bcaa87c7834c46f99e7b.json', 'utf8'));
  full.serisesList=full.serisesList.slice(0,4);full.updateNotice='更新至4/30集';
  full.serisesList[1].action.value = full.serisesList[1].action.value.replace(full.showId, 'otherShow');
  full.serisesList[2].chapterName = '预告';
  full.serisesList[3].peripheryVideoType = 1;
  const h = createHandler(async url => url.includes('so.youku.com') ? new Response('verification')
    : json(new URL(url).searchParams.has('appScene') ? full : {message:'success',originNodes:[{data:{showId:full.showId,tempTitle:'嫁金钗',episodeTotal:30,featureDTO:{text:'电视剧'}}}]}));
  const d = await (await h(request(`/v1/youku/series/${full.showId}?q=嫁金钗`))).json() as any;
  assert.equal(d.total, 2);
  assert.equal(d.main_total,1);
  assert.equal(d.preview_total,1);
  assert.equal(d.complete, false);
  assert.deepEqual(d.missing_episode_numbers, [2,4]);
  assert.deepEqual(d.unavailable_episode_numbers,[3]);
});

test('Youku official JSON search and episode API recover from web challenges without mixing shows', async () => {
  const search = JSON.parse(await readFile('test/fixtures/youku-search-api.json', 'utf8'));
  const full = JSON.parse(await readFile('test/fixtures/youku-episode-api.json', 'utf8'));
  for (const wrongId of [false, true]) {
    const handler = createHandler(async (url) => {
      if (url.includes('so.youku.com')) return new Response('verification');
      const u = new URL(url);
      if (u.searchParams.get('appScene') === 'show_episode') {
        assert.equal(u.searchParams.get('showIds'), full.showId);
        return json({ ...full, showId: wrongId ? 'differentShow' : full.showId });
      }
      return json(search);
    });
    const response = await handler(request('/v1/youku/search?view=series&q=甄嬛传'));
    const d = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(d.results[0].id, full.showId);
    assert.equal(d.results[0].year, '2011');
    const result = await handler(request(d.results[0].detail_url));
    const catalogue = await result.json() as any;
    assert.equal(catalogue.complete, !wrongId);
    if (!wrongId) {
      assert.equal(catalogue.source, 'youku_episode_api');
      assert.equal(catalogue.total, 76);
      assert.deepEqual(catalogue.episodes.map((e: any) => e.episode_number), Array.from({length:76}, (_, i) => i + 1));
    } else {
      assert.ok(catalogue.warnings.includes('YOUKU_CATALOGUE_SCHEMA_CHANGED'));
      assert.equal(catalogue.total, 5);
    }
  }
});

test('Youku JSON search rejects third-party-only shows and malformed payloads', async () => {
  const data = JSON.parse(await readFile('test/fixtures/youku-search-api.json', 'utf8'));
  const replace = (x: unknown): unknown => Array.isArray(x) ? x.map(replace) : x && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'isYouku' || k === 'hasYouku' ? 0 : replace(v)])) : x;
  for (const [payload, expectedStatus] of [[replace(data), 200], [{message:'error'}, 503]] as const) {
    const h = createHandler(async (url) => url.includes('so.youku.com') ? new Response('', {status:403}) : json(payload));
    const r = await h(request('/v1/youku/search?view=series&q=甄嬛传'));
    assert.equal(r.status, expectedStatus);
    assert.equal((await r.json() as any).total, 0);
  }
});

const json = (x: unknown) => new Response(JSON.stringify(x));
const request = (path: string) => new Request('https://example.test' + path);
const iq = (id: string, year: string) => ({
  albumInfo: {
    qipuId: id,
    title: '同名剧',
    channel: '电视剧,2',
    siteId: 'iqiyi',
    totalNumber: 2,
    year: { value: year },
    pageUrl: `https://www.iqiyi.com/v_${id}.html`,
  },
});
const qq = (id: string, year: string, foreign = false) => ({
  videoInfo: {
    title: '同名剧',
    year,
    typeName: '电视剧',
    videoType: 2,
    playSites: [
      {
        totalEpisode: 3,
        episodeInfoList: [
          {
            title: '1',
            url: foreign
              ? 'https://v.qq.com/search_redirect.html?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_foreign.html'
              : `https://v.qq.com/x/cover/${id}/ep1.html`,
          },
        ],
      },
    ],
  },
});
const yk = (id: string, prefix: string, year: string) => ({
  nodes: [
    {
      nodes: [
        {
          data: {
            showId: id,
            episodeTotal: 2,
            tempTitle: '同名剧',
            featureDTO: { text: `电视剧 · ${year}` },
          },
        },
      ],
    },
    {
      nodes: [1, 2].map((n) => ({
        data: { videoId: `${prefix}${n}`, orderId: n, title: `同名剧 ${n}`, chapterName: '正片' },
      })),
    },
  ],
});
// Shapes reflect public payloads, trimmed to the fields used by each adapter.
const upstream: Fetcher = async (url, init) => {
  if (url.includes('mesh.if')) return json({ data: { templates: [iq('101', '2020'), iq('102', '2025')] } });
  if (url.includes('pcw-api')) {
    const id = new URL(url).searchParams.get('aid')!;
    return json({
      code: 'A00000',
      data: {
        albumId: id,
        total: 2,
        hasMore: false,
        epsodelist: [2, 1].map((n) => ({
          order: n,
          name: `同名剧 ${n}`,
          playUrl: `https://www.iqiyi.com/v_${id}ep${n}.html`,
          contentType: 1,
        })),
      },
    });
  }
  if (url.includes('MbSearch'))
    return json({
      ret: 0,
      data: {
        normalList: {
          itemList: [qq('cover101', '2020'), qq('cover102', '2025'), qq('foreign1', '2025', true)],
        },
      },
    });
  if (url.includes('GetPageData')) {
    const cid = JSON.parse(String(init?.body)).page_params.cid;
    return json({
      ret: 0,
      data: {
        has_next_page: false,
        module_list_datas: [
          {
            module_datas: [
              {
                module_params: { is_all_data: 'true' },
                item_data_lists: {
                  item_datas: ['1', '2', '彩蛋1'].map((title, i) => ({
                    item_params: { cid, vid: `${cid}ep${i + 1}`, title, c_title_output: title },
                  })),
                },
              },
            ],
          },
        ],
      },
    });
  }
  if (url.includes('so.youku'))
    return new Response(
      'window.__INITIAL_DATA__ = ' +
        JSON.stringify({
          data: { nodes: [yk('show101abc', 'Xalpha', '2020'), yk('show102abc', 'Xbeta', '2025')] },
        }) +
        ';window.other=1;',
    );
  if (url.includes('mobileso'))
    return json({code:200,data:{contents:[101,102].map((cid,i)=>({type:'program',data:{yearList:[{title:'同名剧',year:String(2020+i*5),total:2,desc:[{label:'类型',text:'电视剧'}],sourceList:[{source:'imgo',videoList:[{url:`https://www.mgtv.com/b/${cid}/${i===0?1001:2001}.html`}]}]}]}}))}});
  if (url.includes('pcweb.api')) {
    const u = new URL(url),
      vid = u.searchParams.get('video_id'),
      page = Number(u.searchParams.get('page')),
      cid = vid === '1001' ? '101' : '102';
    assert.ok([1, 2].includes(page));
    return json({
      code: 200,
      data: {
        total_page: 2,
        count: 2,
        current_page: page,
        list: [{ t1: String(page), t2: `第${page}集`, url: `/b/${cid}/${Number(vid) + page - 1}.html` }],
      },
    });
  }
  if (url.includes('/search/type'))
    return json({
      code: 0,
      data: {
        result: [1, 2].map((n) => ({ season_id: 100 + n, title: '同名剧', season_type_name: '国创' })),
      },
    });
  if (url.includes('/season?')) {
    const id = new URL(url).searchParams.get('season_id');
    return json({
      code: 0,
      result: {
        season_id: Number(id),
        title: '同名剧',
        total: 2,
        episodes: [1, 2].flatMap((n) => [
          {
            title: String(n),
            section_type: 0,
            long_title: `正片${n}`,
            link: `https://www.bilibili.com/bangumi/play/ep${id}${n}`,
          },
          {
            title: String(n),
            section_type: 1,
            badge: '预告',
            link: `https://www.bilibili.com/bangumi/play/ep${id}9${n}`,
          },
        ]),
      },
    });
  }
  throw Error('Unexpected upstream: ' + url);
};

test('default aggregate returns multiple series per site, and each selected detail stays within its exact ID', async () => {
  const handler = createHandler(upstream);
  const aggregate = (await (await handler(request('/v1/search?view=series&q=同名剧'))).json()) as any;
  assert.equal(aggregate.view, 'series');
  assert.equal(aggregate.total, 10);
  assert.equal(aggregate.partial, false);
  assert.ok(aggregate.results.every((r: any) => r.content_type === 'series' && !('episode_number' in r)));
  for (const platform of Object.keys(PLATFORMS) as Platform[]) {
    const r = await handler(request(`/v1/${platform}/search?view=series&q=同名剧`)),
      d = (await r.json()) as any;
    assert.equal(r.status, 200, platform);
    assert.equal(d.total, 2, platform);
    assert.equal(d.providers.length, 1);
    assert.deepEqual(
      d.results,
      aggregate.results.filter((x: any) => x.platform === platform),
    );
    assert.ok(d.results.every((s: any) => s.platform === platform));
    for (const selected of d.results) {
      const response = await handler(request(selected.detail_url)),
        catalogue = (await response.json()) as any;
      assert.equal(response.status, 200, JSON.stringify(catalogue));
      assert.equal(catalogue.complete, true, platform);
      assert.equal(catalogue.series.id, selected.id);
      assert.equal(catalogue.main_total, 2);
      assert.equal(catalogue.extra_total, platform === 'tencent' ? 1 : 0);
      assert.deepEqual(
        catalogue.episodes.filter((x: any) => x.episode_type === 'main').map((x: any) => x.episode_number),
        [1, 2],
      );
      assert.ok(
        catalogue.episodes.every(
          (x: any) => x.platform === platform && new URL(x.url).hostname === PLATFORMS[platform].domain,
        ),
      );
      if (platform === 'youku')
        assert.ok(
          catalogue.episodes.every((x: any) =>
            x.url.includes(selected.id === 'show101abc' ? 'Xalpha' : 'Xbeta'),
          ),
        );
      if (platform === 'iqiyi' || platform === 'tencent')
        assert.ok(catalogue.episodes.every((x: any) => x.url.includes(selected.id)));
    }
  }
});
test('detail validates authentication, platform IDs and parameters before making requests', async () => {
  let calls = 0;
  const handler = createHandler(async () => {
    calls++;
    throw Error('unexpected');
  });
  for (const path of [
    '/v1/iqiyi/series/https%3Aevil?q=同名剧',
    '/v1/youku/series/..%2Fevil?q=同名剧',
    '/v1/mango/series/123?q=同名剧',
    '/v1/bilibili/series/ss1?q=同名剧&url=https://evil.test',
    '/v1/search?view=series&q=同名剧&view=series&mode=all',
    '/v1/search?view=series&q=同名剧&view=invalid',
  ])
    assert.equal((await handler(request(path))).status, 400, path);
  assert.equal((await handler(request('/v1/iqiyi/series/101?q=同名剧'), { API_KEY: 'secret' })).status, 401);
  assert.equal(calls, 0);
});
test('failed pages, duplicate numbers and search previews never claim a complete directory', async () => {
  const handler = createHandler(async (url, init) => {
    if (url.includes('pcweb.api') && new URL(url).searchParams.get('page') === '2')
      return new Response('', { status: 403 });
    if (url.includes('pcw-api'))
      return json({
        code: 'A00000',
        data: {
          albumId: '101',
          total: 2,
          epsodelist: [1, 2].map((n) => ({
            order: 1,
            name: '第1集',
            playUrl: `https://www.iqiyi.com/v_conflict${n}.html`,
          })),
        },
      });
    if (url.includes('GetPageData')) return new Response('', { status: 503 });
    return upstream(url, init);
  });
  for (const path of [
    '/v1/mango/series/101-1001?q=同名剧',
    '/v1/iqiyi/series/101?q=同名剧',
    '/v1/tencent/series/cover101?q=同名剧',
  ]) {
    const d = (await (await handler(request(path))).json()) as any;
    assert.equal(d.complete, false);
    assert.ok(d.warnings.includes('EPISODE_LIST_INCOMPLETE'));
  }
});
test('Youku detail remains tied to requested show and reports unavailable when it is absent', async () => {
  const r = await createHandler(upstream)(request('/v1/youku/series/missingshow?q=同名剧'));
  const d = (await r.json()) as any;
  assert.equal(r.status, 503);
  assert.equal(d.total, 0);
  assert.equal(d.complete, false);
  assert.ok(d.warnings.includes('SERIES_NOT_FOUND'));
  assert.throws(() => embeddedJson('window.__INITIAL_DATA__ = alert(1)', 'window.__INITIAL_DATA__'));
  assert.deepEqual(
    embeddedJson(
      'window.__INITIAL_DATA__={"text":"} \\\" {","nested":[1,2]};evil()',
      'window.__INITIAL_DATA__',
    ),
    { text: '} \" {', nested: [1, 2] },
  );
});
test('complete detail caches independently and query limits never truncate a selected directory', async () => {
  const saved = new Map<string, Response>();
  let calls = 0;
  const cache: CacheStore = {
    async match(k) {
      return saved.get(k.url)?.clone();
    },
    async put(k, v) {
      saved.set(k.url, v.clone());
    },
  };
  const handler = createHandler(async (url, init) => {
    calls++;
    return upstream(url, init);
  }, cache);
  const s = (await (await handler(request('/v1/iqiyi/search?view=series&q=同名剧&limit=1'))).json()) as any;
  assert.equal(s.total, 1);
  assert.equal(s.providers[0].truncated, true);
  const first = (await (await handler(request(s.results[0].detail_url))).json()) as any;
  assert.equal(first.total, 2);
  assert.equal(first.cached, false);
  const count = calls;
  const second = (await (await handler(request(s.results[0].detail_url))).json()) as any;
  assert.equal(second.cached, true);
  assert.equal(calls, count);
});

test('trimmed official payloads preserve Youku show boundaries and Bilibili preview sections', async () => {
  const { readFile } = await import('node:fs/promises');
  const yk = await readFile('test/fixtures/youku-series.json', 'utf8');
  const bili = await readFile('test/fixtures/bilibili-season.json', 'utf8');
  const handler = createHandler(async (url) =>
    url.includes('youku')
      ? new Response('window.__INITIAL_DATA__=' + yk)
      : url.includes('/season?')
        ? new Response(bili)
        : json({ code: 0, data: { numResults: 0 } }),
  );
  const y = (await (await handler(request('/v1/youku/series/cbff984c962411de83b1?q=甄嬛传'))).json()) as any;
  assert.equal(y.total, 76);
  assert.equal(y.complete, true);
  assert.equal(y.episodes[75].episode_number, 76);
  const b = (await (await handler(request('/v1/bilibili/series/ss45975'))).json()) as any;
  assert.equal(b.total, 17);
  assert.equal(b.main_total, 9);
  assert.equal(b.preview_total, 8);
  assert.equal(b.complete, true);
  assert.ok(b.episodes.filter((e:any)=>e.episode_type==='main').every((e: any) => !e.title.includes('预告')));
  assert.deepEqual(b.episodes.filter((e:any)=>e.episode_type==='preview'),b.previews);
});

test('Bilibili public all-search and section fallbacks retain exact season and complete main episodes', async () => {
  const { readFile } = await import('node:fs/promises');
  const all = await readFile('test/fixtures/bilibili-all-search.json', 'utf8');
  const section = await readFile('test/fixtures/bilibili-section.json', 'utf8');
  const handler = createHandler(async (url) => {
    if (url.includes('/search/all/v2')) return new Response(all);
    if (url.includes('/season/section?')) return new Response(section);
    return new Response('', { status: 412 });
  });
  const results = (await (await handler(request('/v1/bilibili/search?view=series&q=三体'))).json()) as any;
  assert.ok(results.total >= 1);
  assert.equal(results.partial, true);
  assert.ok(results.providers[0].warnings.includes('DISCOVERY_FROM_BILIBILI_ALL'));
  const selected = results.results.find((r: any) => r.id === 'ss45975');
  assert.ok(selected);
  const r = await handler(request(selected.detail_url)),
    d = (await r.json()) as any;
  assert.equal(r.status, 200);
  assert.equal(d.source, 'bilibili_section');
  assert.equal(d.complete, true);
  assert.equal(d.total, 9);
  assert.equal(d.series.id, 'ss45975');
  assert.ok(d.warnings.includes('season:HTTP_412'));
  assert.deepEqual(
    d.episodes.map((e: any) => e.episode_number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('cold Bilibili section fallback checks SSR season metadata and section ID', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile('test/fixtures/bilibili-page.html', 'utf8');
  const section = await readFile('test/fixtures/bilibili-section.json', 'utf8');
  const handler = createHandler(async (url) =>
    url.includes('www.bilibili.com/bangumi/play/')
      ? new Response(page)
      : url.includes('/season/section?')
        ? new Response(section)
        : new Response('', { status: 412 }),
  );
  const d = (await (await handler(request('/v1/bilibili/series/ss45975'))).json()) as any;
  assert.equal(d.complete, true);
  assert.equal(d.total, 9);
  assert.equal(d.series.title, '我的三体 第四季');
  const r = await handler(request('/v1/bilibili/series/ss99999'));
  const wrong = (await r.json()) as any;
  assert.equal(r.status, 503);
  assert.equal(wrong.total, 0);
  assert.ok(wrong.warnings.includes('SEASON_ID_MISMATCH'));
});

test('a verified catalogue with only previews still returns them inline as usable episode links', async () => {
  const full=JSON.parse(await readFile('test/fixtures/youku-bcaa87c7834c46f99e7b.json','utf8'));
  full.serisesList=full.serisesList.slice(-2);
  const h=createHandler(async url=>url.includes('so.youku.com')?new Response('challenge'):
    json(new URL(url).searchParams.has('appScene')?full:{message:'success',originNodes:[{data:{showId:full.showId,tempTitle:'嫁金钗',episodeTotal:30,featureDTO:{text:'电视剧'}}}]}));
  const response=await h(request(`/v1/youku/series/${full.showId}?q=嫁金钗`));const d=await response.json() as any;
  assert.equal(response.status,200);assert.equal(d.ok,true);assert.equal(d.total,2);assert.equal(d.main_total,0);assert.equal(d.extra_total,0);assert.equal(d.preview_total,2);assert.equal(d.complete,false);
  assert.deepEqual(d.episodes.map((e:any)=>[e.episode_number,e.episode_type]),[[22,'preview'],[23,'preview']]);
});
