import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DOCS_HTML, DOCS_JS } from '../src/documentation';
import { CAPABILITIES } from '../src/aggregate';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('official explorer sends native page without local result limit and renders raw cards as inert text', async () => {
  const {window,document}=parseHTML(DOCS_HTML);
  for (const [id,value] of [['platform','all'],['mode','official']])Object.defineProperty(document.getElementById(id)!,'value',{value,writable:true});
  Object.assign(window,{location:{origin:'https://example.test'}});
  Object.assign(document.getElementById('query-form')!,{reportValidity:()=>true});
  document.getElementById('search-page')!.setAttribute('value','2');
  const calls: string[]=[];
  const fetcher=async(url:string)=>{
    if(url==='/v1/platforms')return new Response(JSON.stringify({platforms:Object.values(CAPABILITIES)}));
    calls.push(url);
    return new Response(JSON.stringify({view:'official',total:2,results:[
      {platform:'bilibili',title:'作者',url:'https://space.bilibili.com/123',raw:{title:'<img src=x onerror=alert(1)>'}},
      {platform:'bilibili',title:'未知模板',url:null,raw:{custom:'全部保留'}},
    ]}));
  };
  new Script(DOCS_JS).runInNewContext({window,document,fetch:fetcher,URL,AbortSignal,navigator:{},setTimeout:()=>0});
  document.getElementById('query-form')!.dispatchEvent(new window.Event('submit',{cancelable:true}));
  await tick();await tick();
  const u=new URL(calls[0]);
  assert.equal(u.searchParams.get('view'),'official');
  assert.equal(u.searchParams.get('page'),'2');
  assert.equal(u.searchParams.has('mode'),false);
  assert.equal(u.searchParams.has('limit'),false);
  assert.equal(document.querySelectorAll('.result-row').length,2);
  assert.equal(document.querySelectorAll('#result-list details').length,2);
  assert.equal(document.querySelectorAll('#result-list img').length,0);
  assert.match(document.getElementById('result-list')!.textContent||'',/<img/);
});

test('documentation explorer sends the chosen single-site query, renders safe links and keeps secrets out of copied commands', async () => {
  const { window, document } = parseHTML(DOCS_HTML);
  const calls: { url: string; authorization?: string }[] = [], copied: string[] = [];
  // Select.value and validity are browser primitives not implemented by this lightweight DOM.
  for (const [id, value] of [['platform', 'all'], ['mode', 'series']]) Object.defineProperty(document.getElementById(id)!, 'value', { value, writable: true });
  Object.assign(window, { location: { origin: 'https://example.test' } });
  Object.assign(document.getElementById('query-form')!, { reportValidity: () => true });
  const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url === '/v1/platforms') return new Response(JSON.stringify({ platforms: Object.values(CAPABILITIES) }));
    calls.push({ url, authorization: init?.headers?.Authorization });
    return new Response(JSON.stringify({ total: 2, mode: 'all', providers: [{ platform: 'iqiyi', count: 2, status: 'ok', catalog: { total: 2, expected_total: 2, complete: true } }], results: [
      { title: '<img src=x onerror=alert(1)>', url: 'https://www.iqiyi.com/v_ep1.html', platform: 'iqiyi', content_type: 'episode', episode_number: 1 },
      { title: '危险外链', url: 'javascript:alert(1)', platform: 'iqiyi', content_type: 'search' },
    ] }));
  };
  new Script(DOCS_JS).runInNewContext({ window, document, fetch: fetcher, URL, AbortSignal, navigator: { clipboard: { async writeText(value: string) { copied.push(value); } } }, setTimeout: () => 0 });
  await tick();
  assert.equal(document.querySelectorAll('.platform-card').length, 5);
  Object.defineProperty(document.getElementById('platform')!, 'value', { value: 'iqiyi', writable: true });
  document.getElementById('api-key')!.setAttribute('value', 'super-secret');
  document.getElementById('limit')!.setAttribute('value', '5');
  document.getElementById('query')!.setAttribute('value', '海市蜃楼');
  document.getElementById('query-form')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).pathname, '/v1/iqiyi/search');
  assert.equal(new URL(calls[0].url).searchParams.get('view'), 'series'); assert.equal(calls[0].authorization, 'Bearer super-secret');
  assert.ok(!calls[0].url.includes('super-secret'));
  assert.equal(document.querySelectorAll('#result-list img').length, 0);
  assert.equal(document.querySelectorAll('#result-list a').length, 1);
  assert.match(document.getElementById('result-list')!.textContent || '', /<img/);
  document.getElementById('copy-curl')!.dispatchEvent(new window.Event('click')); await tick();
  assert.ok(copied[0].includes('/v1/iqiyi/search')); assert.ok(copied[0].includes('<YOUR_API_KEY>')); assert.ok(!copied[0].includes('super-secret'));
});

test('series explorer opens the exact selected catalogue, retains auth headers and toggles episodes without fetching again', async () => {
  const { window, document } = parseHTML(DOCS_HTML);
  for (const [id, value] of [['platform', 'all'], ['mode', 'series']]) Object.defineProperty(document.getElementById(id)!, 'value', { value, writable: true });
  Object.assign(window, { location: { origin: 'https://example.test' } });
  Object.assign(document.getElementById('query-form')!, { reportValidity: () => true });
  const calls: { url: string; auth?: string }[] = [];
  const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url === '/v1/platforms') return new Response(JSON.stringify({ platforms: Object.values(CAPABILITIES) }));
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.includes('/series/')) return new Response(JSON.stringify({ ok: true, total: 2, main_total: 2, extra_total: 0, complete: true, episodes: [1, 2].map(n => ({ platform: 'youku', title: `所选剧集 ${n}`, episode_number: n, episode_type: 'main', url: `https://v.youku.com/v_show/id_Xep${n}.html` })) }));
    return new Response(JSON.stringify({ view: 'series', total: 2, results: [
      { platform: 'youku', content_type: 'series', id: 'version2025', title: '同名剧', year: '2025', detail_url: '/v1/youku/series/version2025?q=同名剧' },
      { platform: 'youku', content_type: 'series', id: 'version2020', title: '同名剧', year: '2020', detail_url: 'https://evil.test/v1/youku/series/version2020' },
    ] }));
  };
  new Script(DOCS_JS).runInNewContext({ window, document, fetch: fetcher, URL, AbortSignal, navigator: {}, setTimeout: () => 0 });
  document.getElementById('api-key')!.setAttribute('value', 'secret');
  document.getElementById('query-form')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  assert.equal(new URL(calls[0].url).searchParams.get('view'), 'series'); assert.equal(new URL(calls[0].url).searchParams.has('mode'), false);
  assert.equal(document.querySelectorAll('.series-card').length, 2);
  const buttons = document.querySelectorAll('.series-card>button');
  buttons[0].dispatchEvent(new window.Event('click')); await tick(); await tick();
  assert.equal(new URL(calls[1].url).pathname, '/v1/youku/series/version2025'); assert.equal(calls[1].auth, 'Bearer secret');
  assert.equal(document.querySelectorAll('.catalogue-panel a').length, 2);
  assert.match(document.querySelector('.catalogue-panel')!.textContent || '', /目录完整/);
  assert.equal(buttons[0].getAttribute('aria-expanded'), 'true');
  buttons[0].dispatchEvent(new window.Event('click')); await tick();
  assert.equal(buttons[0].getAttribute('aria-expanded'), 'false'); assert.equal(calls.length, 2);
  buttons[1].dispatchEvent(new window.Event('click')); await tick();
  assert.equal(calls.length, 2); assert.match(document.querySelectorAll('.catalogue-panel')[1].textContent || '', /目录地址无效/);
});

test('documentation exposes exactly two modes, no old album selector, and inline playable previews', async () => {
  const {window,document}=parseHTML(DOCS_HTML);
  assert.deepEqual([...document.querySelectorAll('#mode option')].map(o=>o.getAttribute('value')),['official','series']);
  assert.equal(document.getElementById('album-id'),null);assert.ok(!DOCS_HTML.includes('album_id'));
  for(const [id,value] of [['platform','youku'],['mode','series']])Object.defineProperty(document.getElementById(id)!,'value',{value,writable:true});
  Object.assign(window,{location:{origin:'https://test'}});Object.assign(document.getElementById('query-form')!,{reportValidity:()=>true});
  new Script(DOCS_JS).runInNewContext({window,document,URL,AbortSignal,navigator:{},setTimeout:()=>0,fetch:async(url:string)=>{
    if(url==='/v1/platforms')return new Response(JSON.stringify({platforms:Object.values(CAPABILITIES)}));
    if(url.includes('/series/'))return new Response(JSON.stringify({ok:true,total:23,main_total:21,preview_total:2,complete:false,unavailable_episode_numbers:[22],missing_episode_numbers:[],ai:{status:'applied',recovered:0},episodes:[{platform:'youku',title:'第21集',url:'https://v.youku.com/v_show/id_Xmain.html',episode_number:21,episode_type:'main'},{platform:'youku',title:'第22集预告',url:'https://v.youku.com/v_show/id_Xreal.html',episode_number:22,episode_type:'preview'}],previews:[{platform:'youku',title:'第22集预告',url:'https://v.youku.com/v_show/id_Xreal.html',episode_number:22,episode_type:'preview'}]}));
    return new Response(JSON.stringify({results:[{platform:'youku',content_type:'series',id:'longSeries',title:'嫁金钗',detail_url:'/v1/youku/series/longSeries?q=嫁金钗'}]}));
  }});
  document.getElementById('query-form')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();await tick();
  document.querySelector('.series-card>button')!.dispatchEvent(new window.Event('click'));await tick();await tick();
  assert.match(document.querySelector('.catalogue-panel')!.textContent||'',/正片待确认/);assert.match(document.querySelector('.catalogue-panel')!.textContent||'',/DeepSeek/);
  assert.equal(document.querySelectorAll('.catalogue-panel details').length,0);assert.equal(document.querySelectorAll('.catalogue-panel .result-row a').length,2);assert.match(document.querySelectorAll('.catalogue-panel .result-row')[1].textContent||'',/预告/);assert.ok(!document.querySelector('.catalogue-panel')!.textContent?.includes('缺集编号'));
});
