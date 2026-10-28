import { writeFile } from 'node:fs/promises';
import { createHandler } from '../src/index';
import { PLATFORMS, type Env } from '../src/types';

// Run native searches from Node or exercise an already deployed Worker with API_BASE_URL.
const env: Env = {
  BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
  UPSTREAM_TIMEOUT_MS: '10000',
};
const probes = { tencent: '三体', iqiyi: '狂飙', youku: '甄嬛传', mango: '歌手', bilibili: '三体' };
const report = [];
for (const platform of Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[]) {
  const url = new URL('/v1/search', process.env.API_BASE_URL || 'https://local.test');
  url.searchParams.set('q', probes[platform]); url.searchParams.set('platforms', platform); url.searchParams.set('limit', '2');
  const req = new Request(url, { headers: process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {} });
  try {
    const r = process.env.API_BASE_URL ? await fetch(req, { signal: AbortSignal.timeout(25000) }) : await createHandler()(req, env);
    const d = await r.json() as any;
    const row = { platform, http_status: r.status, status: d.providers?.[0]?.status ?? 'error', count: d.total ?? 0, warnings: d.providers?.[0]?.warnings ?? [], example: d.results?.[0]?.url ?? null };
    report.push(row); console.log(JSON.stringify(row));
  } catch {
    report.push({ platform, http_status: null, status: 'error', count: 0, warnings: ['SMOKE_REQUEST_FAILED'], example: null });
    console.log(`${platform}: SMOKE_REQUEST_FAILED`);
  }
}
await writeFile('smoke-results.json', JSON.stringify({ checked_at: new Date().toISOString(), providers: report }, null, 2) + '\n');
const failures = report.filter(r => !r.count || !['ok', 'degraded'].includes(r.status));
if (failures.length) { console.error(`Live smoke: ${failures.map(r => r.platform).join(', ')} unavailable or empty.`); process.exitCode = 1; }
