import { writeFile } from 'node:fs/promises';
import { createHandler } from '../src/index';
import { PLATFORMS, type Env } from '../src/types';

// Exercise the public two-level contract, from Node or against a deployed Worker.
const env: Env = { UPSTREAM_TIMEOUT_MS: '10000' };
const handler = createHandler();
const probes = { tencent: '三体', iqiyi: '海市蜃楼', youku: '甄嬛传', mango: '歌手2025', bilibili: '三体' };
const base = process.env.API_BASE_URL || 'https://local.test';
const headers: Record<string, string> = process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {};
const send = (url: URL) => process.env.API_BASE_URL
  ? fetch(url, { headers, signal: AbortSignal.timeout(60000) })
  : handler(new Request(url, { headers }), env);
const report = [];
for (const platform of Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[]) {
  const url = new URL(`/v1/${platform}/search`, base);
  url.searchParams.set('q', probes[platform]); url.searchParams.set('limit', '2'); url.searchParams.set('view', 'series');
  try {
    const r = await send(url), d = await r.json() as any;
    let catalogue: any, detailStatus: number | null = null;
    const selected = d.results?.[0];
    if (selected?.detail_url) {
      const detailUrl = new URL(selected.detail_url, base);
      if (detailUrl.origin !== new URL(base).origin) throw Error('Unexpected detail origin');
      const detail = await send(detailUrl); detailStatus = detail.status; catalogue = await detail.json();
    }
    const row = { platform, http_status: r.status, status: d.providers?.[0]?.status ?? 'error', series_count: d.total ?? 0, selected_id: selected?.id ?? null, detail_http_status: detailStatus, episode_count: catalogue?.total ?? 0, main_total: catalogue?.main_total ?? 0, extra_total: catalogue?.extra_total ?? 0, complete: catalogue?.complete ?? false, warnings: [...(d.providers?.[0]?.warnings ?? []), ...(catalogue?.warnings ?? [])] };
    report.push(row); console.log(JSON.stringify(row));
  } catch {
    report.push({ platform, http_status: null, status: 'error', series_count: 0, episode_count: 0, complete: false, warnings: ['SMOKE_REQUEST_FAILED'] });
    console.log(`${platform}: SMOKE_REQUEST_FAILED`);
  }
}
await writeFile('smoke-results.json', JSON.stringify({ checked_at: new Date().toISOString(), view: 'series', providers: report }, null, 2) + '\n');
const failures = report.filter(r => !r.series_count || !r.episode_count || !r.complete || !['ok', 'degraded'].includes(r.status));
if (failures.length) { console.error(`Live smoke: ${failures.map(r => r.platform).join(', ')} unavailable, empty or incomplete.`); process.exitCode = 1; }
