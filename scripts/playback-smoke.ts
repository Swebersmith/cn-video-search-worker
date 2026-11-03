import { writeFile } from 'node:fs/promises';
import { createHandler } from '../src/index';
import type { Platform } from '../src/types';

const handler = createHandler();
const probes: [Platform, string, string][] = [
  ['youku', '嫁金钗', 'bcaa87c7834c46f99e7b'],
  ['tencent', '走马上任', 'mzc00200zsqz54y'],
  ['iqiyi', '罚罪2', '3927103178259701'],
  ['mango', '歌手2025', '753011-22869999'],
  ['bilibili', '间谍过家家', 'ss41410'],
];
const base = process.env.API_BASE_URL;
const modes = process.env.AI_SMOKE_MODES?.split(',') || ['off'];
const report = await Promise.all(probes.flatMap(probe => modes.map(mode => ({probe,mode}))).map(async ({probe:[platform, title, id], mode}) => {
  const path = `/v1/${platform}/series/${id}?q=${encodeURIComponent(title)}&ai=${mode}`;
  try {
    const response = base ? await fetch(base + path, { signal: AbortSignal.timeout(60000) })
      : await handler(new Request('https://test' + path), { UPSTREAM_TIMEOUT_MS: '10000' });
    const d = await response.json() as any;
    const mainNumbers = new Set(d.episodes?.filter((e: any) => e.episode_type === 'main').map((e: any) => e.episode_number).filter((n: any) => n !== null));
    const duplicates = d.episodes?.filter((e: any) => e.episode_type === 'preview' && e.episode_number !== null && mainNumbers.has(e.episode_number));
    const ok = response.ok && d.ai_mode === mode && d.main_total > 0 && d.total === d.episodes?.length && duplicates?.length === 0 &&
      !('previews' in d) && !('all_episodes' in d) && d.episodes.every((e: any) => Array.isArray(e.badges)) &&
      (platform !== 'youku' || (d.main_total === 30 && d.episodes.filter((e: any) => e.episode_number >= 27).every((e: any) => e.badges.includes('收官礼'))));
    return { platform, title, ai_mode:d.ai_mode, ai_status:d.ai?.status, ok, status: response.status, total: d.total, main_total: d.main_total,
      preview_total: d.preview_total, extra_total: d.extra_total, complete: d.complete, source: d.source,
      warnings: d.warnings, badge_examples: d.episodes?.filter((e: any) => e.badges?.length).slice(-5).map((e: any) => ({ number: e.episode_number, title: e.title, badges: e.badges })),
      took_ms: d.took_ms };
  } catch (e) { return { platform, title, ok: false, error: e instanceof Error ? e.message : 'SMOKE_FAILED' }; }
}));
await writeFile('docs/playback-live-2026-11-03.json', JSON.stringify({ checked_at: new Date().toISOString(), base: base || 'local code with live upstreams', report }, null, 2) + '\n');
for (const row of report) console.log(JSON.stringify(row));
if (report.some(r => !r.ok)) process.exitCode = 1;
