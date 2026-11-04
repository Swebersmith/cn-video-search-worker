import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTmdbEnricher } from '../src/tmdb';
import { createHandler } from '../src/index';
import type { Fetcher, CacheStore } from '../src/types';

const show = { id: 42, name: '测试剧', first_air_date: '2024-01-01', poster_path: '/poster.jpg', overview: '剧情简介' };
const seed = () => ({ title: '测试剧', year: '2024', kind: 'series' });
const episodes = () => [1, 2].map(n => ({ episode_number: n, episode_type: 'main', title: `第${n}集`, url: `https://example.com/${n}` }));
const env = { TMDB_READ_ACCESS_TOKEN: 'test-token' };

test('TMDB enrichment uses server auth, deduplicates and caches without credentials', async () => {
  let calls = 0;
  const store = new Map<string, Response>();
  const cache: CacheStore = { async match(k) { return store.get(k.url)?.clone(); }, async put(k, v) { assert.ok(!k.url.includes('test-token')); store.set(k.url, v); } };
  const fetcher: Fetcher = async (url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    assert.equal(new URL(url).searchParams.get('language'), 'zh-CN');
    assert.ok(!url.includes('test-token'));
    return Response.json({ results: [show] });
  };
  const rows: any[] = [seed(), seed()];
  await createTmdbEnricher(env, fetcher, cache).items(rows);
  assert.equal(calls, 1); assert.equal(rows[0].poster_url, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(rows[1].overview, '剧情简介'); assert.equal(rows[0].tmdb.id, 42);
  await createTmdbEnricher(env, fetcher, cache).items([seed()]); assert.equal(calls, 1);
});

test('TMDB only attaches aligned main episode metadata and preserves links/titles', async () => {
  const fetcher: Fetcher = async url => Response.json(url.includes('/search/') ? { results: [show] } :
    url.includes('/season/') ? { episodes: [1, 2].map(n => ({ id: n, episode_number: n, overview: `剧情${n}`, name: `TMDB${n}`, still_path: '/still.jpg' })) } :
    { seasons: [{ season_number: 0 }, { season_number: 1, episode_count: 2 }] });
  const eps: any[] = [...episodes(), { episode_number: 1, episode_type: 'preview', title: '预告' }];
  const item: any = seed();
  await createTmdbEnricher(env, fetcher).detail(item, eps);
  assert.equal(item.tmdb.episode_status, 'matched'); assert.equal(eps[0].overview, '剧情1');
  assert.equal(eps[0].title, '第1集'); assert.equal(eps[0].url, 'https://example.com/1');
  assert.equal(eps[2].overview, undefined);
});

test('TMDB skips ambiguous titles, wrong year and mismatched/multiple seasons', async () => {
  for (const results of [[show, { ...show, id: 43 }], [{ ...show, first_air_date: '2023-01-01' }], [{ ...show, name: '测试剧续集' }]]) {
    const item: any = seed(); await createTmdbEnricher(env, async () => Response.json({ results })).items([item]);
    assert.notEqual(item.tmdb.status, 'matched'); assert.equal(item.overview, undefined);
  }
  for (const seasons of [[{ season_number: 1, episode_count: 3 }], [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }]]) {
    const eps: any[] = episodes(), item: any = seed();
    await createTmdbEnricher(env, async url => Response.json(url.includes('/search/') ? { results: [show] } : { seasons })).detail(item, eps);
    assert.equal(item.tmdb.episode_status, 'skipped'); assert.equal(eps[0].overview, undefined);
  }
});

test('TMDB handles disabled, failures, API-key auth, and movie matches', async () => {
  const item: any = seed(); let calls = 0;
  const fail: Fetcher = async () => { calls++; throw new Error('private credential'); };
  await createTmdbEnricher({}, fail).items([item]);
  await createTmdbEnricher({ ...env, TMDB_ENABLED: 'off' }, fail).items([item]); assert.equal(calls, 0);
  await createTmdbEnricher(env, fail).items([item]); assert.equal(item.tmdb.status, 'unavailable');
  assert.ok(!JSON.stringify(item).includes('credential'));
  const movie: any = { title: '测试电影', kind: 'movie' };
  await createTmdbEnricher({ TMDB_API_KEY: 'api-key' }, async url => {
    const u = new URL(url); assert.equal(u.searchParams.get('api_key'), 'api-key'); assert.equal(u.pathname, '/3/search/movie');
    return Response.json({ results: [{ id: 7, title: '测试电影', poster_path: '//evil.com/x', overview: '电影剧情' }] });
  }).items([movie]);
  assert.equal(movie.tmdb.media_type, 'movie'); assert.equal(movie.poster_url, null);
});

test('resource handler returns TMDB metadata while keeping original source policy', async () => {
  const fetcher: Fetcher = async url => Response.json(url.startsWith('https://api.themoviedb.org/') ?
    { results: [{ ...show, media_type: 'tv' }] } : { code: 1, list: [{ vod_id: 1, vod_name: '测试剧', vod_year: '2024' }] });
  const r = await createHandler(fetcher)(new Request('https://test/v1/resources/search?sources=jinchan&q=测试剧'), env);
  const data: any = await r.json();
  assert.equal(r.status, 200); assert.equal(data.source_policy, 'third_party_resource_sites');
  assert.equal(data.results[0].overview, '剧情简介'); assert.equal(data.results[0].source, 'third_party');
  assert.ok(!JSON.stringify(data).includes('test-token'));
});
