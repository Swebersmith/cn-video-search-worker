import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DOCS_HTML, DOCS_JS } from '../src/documentation';
import { CAPABILITIES } from '../src/aggregate';

test('resource explorer selects a distinct endpoint, shows provenance and never loads third-party players', async () => {
  const { window, document } = parseHTML(DOCS_HTML);
  for (const [id, value] of [['mode', 'resources'], ['platform', 'all'], ['resource-source', 'jinchan']])
    Object.defineProperty(document.getElementById(id)!, 'value', { value, writable: true });
  document.getElementById('query')!.setAttribute('value', '走马上任');
  document.getElementById('search-page')!.setAttribute('value', '2');
  Object.assign(window, { location: { origin: 'https://test' } });
  Object.assign(document.getElementById('query-form')!, { reportValidity: () => true });
  const calls: string[] = [];
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  new Script(DOCS_JS).runInNewContext({ window, document, URL, AbortSignal, navigator: {}, setTimeout: () => 0,
    fetch: async (url: string) => {
      if (url === '/v1/platforms') return new Response(JSON.stringify({ platforms: Object.values(CAPABILITIES) }));
      calls.push(url);
      return new Response(JSON.stringify({ view: 'resources', total: 1, providers: [{ source_name: '金蝉官采', status: 'ok', count: 1 }],
        results: [{ id: '1', title: '<img src=x onerror=alert(1)>', source_id: 'jinchan', source_name: '金蝉官采', content_type: 'resource',
          lines: [{ name: 'qq', episodes: [
            { title: '第7集 SVIP', url: 'https://v.qq.com/x/cover/show/video.html', link_type: 'official_page' },
            { title: '第三方线路', url: 'https://parser.example.com/player', link_type: 'external_page' },
          ], previews: [] }] }] }));
    } });
  document.getElementById('query-form')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/v1/resources/search');
  assert.equal(u.searchParams.get('sources'), 'jinchan');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.has('view'), false);
  assert.match(document.querySelector('.resource-card')!.textContent || '', /第三方/);
  document.querySelector('.resource-card button')!.dispatchEvent(new window.Event('click'));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(document.querySelectorAll('.resource-card a').length, 1);
  assert.equal(document.querySelectorAll('.resource-card iframe,.resource-card img,.resource-card video').length, 0);
  assert.match(document.querySelector('.resource-card')!.textContent || '', /SVIP/);
  assert.match(document.querySelector('.resource-card')!.textContent || '', /parser.example.com/);
});
