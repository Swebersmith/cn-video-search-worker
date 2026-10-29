import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifySeries, knownCategory, recognizeEpisodes, type EpisodeCandidate } from '../src/ai';
import { episodeCandidates } from '../src/episode-evidence';
import { createHandler } from '../src/index';
import type { SeriesSummary } from '../src/catalogue';
const env = { DEEPSEEK_API_KEY: 'test-server-only-secret' };
const series: SeriesSummary = {
  platform: 'youku',
  platform_name: '优酷',
  id: 'bcaa87c7834c46f99e7b',
  title: '嫁金钗',
  year: '2026',
  type_name: '电视剧',
  kind: 'series',
  total_episodes: 30,
  url: 'https://v.youku.com/video?s=bcaa87c7834c46f99e7b',
  detail_url: '',
  score: 1,
  content_type: 'series',
};
const json = (d: unknown) => new Response(JSON.stringify(d));
const model = (d: unknown) =>
  json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(d) } }] });

test('long content taxonomy retains five genres and rejects short drama, companion, clips and creators', () => {
  for (const [type, category] of [
    ['电影', 'movie'],
    ['电视剧', 'tv'],
    ['综艺', 'variety'],
    ['动漫', 'anime'],
    ['纪录片', 'documentary'],
  ])
    assert.equal(knownCategory('作品', type), category);
  for (const title of ['100集短剧', '微短剧', '竖屏爽剧'])
    assert.equal(knownCategory(title, '电视剧'), 'short_drama');
  for (const title of ['酷陪看·嫁金钗', '片场路透', '解说合集', '官方预告', 'UP主'])
    assert.equal(knownCategory(title, '电视剧'), 'other');
});
test('AI classifies by source IDs but cannot override explicit short-drama or clip exclusions', async () => {
  const items = [
    series,
    { ...series, id: 'shortSeries', title: '微短剧' },
    { ...series, id: 'companion', title: '酷陪看·嫁金钗' },
  ];
  const result = await classifySeries(items, env, async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + env.DEEPSEEK_API_KEY);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.response_format.type, 'json_object');
    assert.ok(!JSON.stringify(body).includes(env.DEEPSEEK_API_KEY));
    return model({ items: items.map((s) => ({ id: s.id, category: 'tv', confidence: 0.99 })) });
  });
  assert.equal(result.categories.get(series.id), 'tv');
  assert.equal(result.categories.get('shortSeries'), 'short_drama');
  assert.equal(result.categories.get('companion'), 'other');
  assert.equal(result.ai.status, 'applied');
});
test('AI errors and malformed JSON degrade to source-based classification without exposing secrets', async () => {
  for (const fetcher of [
    async () => new Response(env.DEEPSEEK_API_KEY, { status: 401 }),
    async () => model({ items: null }),
    async () => {
      throw Error('secret=' + env.DEEPSEEK_API_KEY);
    },
  ]) {
    const d = await classifySeries([series], env, fetcher);
    assert.equal(d.ai.status, 'fallback');
    assert.equal(d.categories.get(series.id), 'tv');
    assert.ok(!JSON.stringify(d).includes(env.DEEPSEEK_API_KEY));
  }
  let calls = 0;
  const disabled = await classifySeries([series], {}, async () => {
    calls++;
    return model({});
  });
  assert.equal(calls, 0);
  assert.equal(disabled.ai.status, 'disabled');
});
test('official evidence detects the real 22nd preview and never admits another show or external URL', async () => {
  const payload = JSON.parse(await readFile('test/fixtures/youku-bcaa87c7834c46f99e7b.json', 'utf8'));
  const c = episodeCandidates(payload, 'youku', series.id, 'official');
  const preview = c.find((v) => v.number_hint === 22)!;
  assert.ok(preview);
  assert.equal(preview.preview, true);
  assert.match(preview.url, /XNjU2ODk3OTY0OA/);
  assert.deepEqual(
    episodeCandidates({ showId: 'foreign', children: payload }, 'youku', series.id, 'official'),
    [],
  );
  assert.deepEqual(
    episodeCandidates(
      { title: '第22集', orderStage: 22, url: 'https://evil.test/22.html' },
      'youku',
      series.id,
      'official',
    ),
    [],
  );
});
const candidate: EpisodeCandidate = {
  ref: 'c22',
  url: 'https://v.youku.com/v_show/id_Xreal22.html',
  title: '嫁金钗 第二十二集',
  label: '第22集',
  number_hint: 22,
  preview: false,
  extra: false,
  source: 'official:$.episodes[21]',
  duration_seconds: 3000,
};
test('AI repair selects a real official candidate and ignores model-invented URLs, IDs or numbering', async () => {
  const d = await recognizeEpisodes(series, [candidate], [], 22, env, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(body.messages).includes(candidate.url));
    return model({
      episodes: [
        {
          candidate_ref: 'does-not-exist',
          episode_number: 22,
          episode_type: 'main',
          confidence: 1,
          url: 'https://evil.test/',
        },
        { candidate_ref: 'c22', episode_number: 23, episode_type: 'main', confidence: 1 },
        {
          candidate_ref: 'c22',
          episode_number: 22,
          episode_type: 'main',
          confidence: 0.99,
          url: 'https://evil.test/',
        },
      ],
    });
  });
  assert.equal(d.episodes.length, 1);
  assert.equal(d.episodes[0].url, candidate.url);
  assert.equal(d.episodes[0].episode_number, 22);
  assert.equal(d.ai.recovered, 1);
  const rejected = await recognizeEpisodes(series, [{ ...candidate, preview: true }], [], 22, env, async () =>
    model({ episodes: [{ candidate_ref: 'c22', episode_number: 22, episode_type: 'main', confidence: 1 }] }),
  );
  assert.equal(rejected.episodes.length, 0);
});
test('AI repairs an unstructured official episode 22 and completeness is recomputed from verified links', async () => {
  const full = JSON.parse(await readFile('test/fixtures/youku-bcaa87c7834c46f99e7b.json', 'utf8'));
  full.serisesList = full.serisesList.slice(0, 21);
  full.serisesList.push({
    title: '风雨归来',
    orderId: null,
    orderStage: 22,
    videoId: 'Xofficial22',
    seconds: 3000,
    iconCorner: { tagText: 'SVIP' },
    action: { value: `youku://play?showid=${series.id}&vid=Xofficial22` },
  });
  const h = createHandler(async (url, init) => {
    if (url.includes('api.deepseek.com')) {
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return input.items
        ? model({ items: [{ id: series.id, category: 'tv', confidence: 0.99 }] })
        : model({
            episodes: input.candidates.map((c: EpisodeCandidate) => ({
              candidate_ref: c.ref,
              episode_number: 22,
              episode_type: 'main',
              confidence: 0.99,
            })),
          });
    }
    if (url.includes('so.youku.com')) return new Response('challenge');
    if (new URL(url).searchParams.has('appScene')) return json(full);
    return json({
      message: 'success',
      originNodes: [
        {
          data: {
            showId: series.id,
            tempTitle: series.title,
            episodeTotal: 30,
            featureDTO: { text: '电视剧' },
          },
        },
      ],
    });
  });
  const r = await h(new Request(`https://test/v1/youku/series/${series.id}?q=嫁金钗`), env),
    d = (await r.json()) as any;
  assert.equal(r.status, 200);
  assert.equal(d.total, 22);
  assert.equal(d.complete, true);
  assert.deepEqual(d.missing_episode_numbers, []);
  assert.equal(d.ai.recovered, 1);
  assert.equal(d.episodes[21].recognition, 'ai');
  assert.ok(d.episodes[21].url.includes('Xofficial22'));
});

test('iQIYI directory discovery includes all five long-form channels but excludes short-drama albums', async () => {
  const genres=[['1','电影'],['2','电视剧'],['3','纪录片'],['4','动漫'],['6','综艺'],['2','短剧']];
  const h=createHandler(async url=>{
    assert.ok(url.includes('mesh.if.iqiyi.com'));
    return json({data:{templates:genres.map(([channel,title],i)=>({albumInfo:{qipuId:String(100+i),title:'同名'+title,channel:title+','+channel,siteId:'iqiyi',totalNumber:20,pageUrl:`https://www.iqiyi.com/v_official${i}.html`}}))}});
  });
  const d=await(await h(new Request('https://test/v1/iqiyi/search?view=series&q=同名'))).json() as any;
  assert.equal(d.total,5);assert.deepEqual(new Set(d.results.map((v:any)=>v.category)),new Set(['movie','tv','documentary','anime','variety']));
  const movie=d.results.find((v:any)=>v.kind==='movie');const film=await(await h(new Request('https://test'+movie.detail_url))).json() as any;
  assert.equal(film.total,1);assert.equal(film.complete,true);
  const short=await(await h(new Request('https://test/v1/iqiyi/series/105?q=同名'))).json() as any;
  assert.equal(short.total,0);assert.ok(short.warnings.includes('CONTENT_TYPE_EXCLUDED'));
});
test('Mango native video cards are excluded even when the website labels a clip as TV or variety', async () => {
  const h=createHandler(async()=>json({code:200,data:{contents:[{type:'video',data:{title:'嫁金钗路透',desc:[{label:'类型',text:'电视剧'}],url:'https://www.mgtv.com/b/717787/23963217.html',updateInfo:'00:40'}}]}}));
  const d=await(await h(new Request('https://test/v1/mango/search?view=series&q=嫁金钗'))).json() as any;
  assert.equal(d.total,0);assert.equal(d.providers[0].ai.status,'not_needed');
});
