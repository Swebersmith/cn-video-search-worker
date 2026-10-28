import { PLATFORMS, type Platform, type Video } from './types';

export function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()];
  }).replace(/\s+/g, ' ').trim().slice(0, 300);
}
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}
export function score(query: string, title: string): number {
  const q = normalize(query), t = normalize(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.includes(q)) return Number((0.8 + 0.19 * q.length / t.length).toFixed(4));
  const chars = new Set(q);
  const overlap = [...new Set(t)].filter(c => chars.has(c)).length;
  // Character overlap plus bigrams allows partial Chinese titles and small spelling differences.
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const a = grams(q), b = grams(t);
  const common = [...a].filter(g => b.has(g)).length;
  const dice = a.size + b.size ? 2 * common / (a.size + b.size) : 0;
  return Number((0.6 * dice + 0.4 * overlap / Math.max(chars.size, new Set(t).size)).toFixed(4));
}

// Only official playback routes survive. Search, login, detail, third-party redirects and media URLs are rejected.
export function canonical(raw: unknown, platform: Platform): { url: string; kind: Video['kind'] } | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return;
  try {
    const value = raw.replace(/&amp;/g, '&');
    const u = new URL(value.startsWith('//') ? `https:${value}` : value, `https://${PLATFORMS[platform].domain}`);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return;
    const p = u.pathname;
    const host = u.hostname.toLowerCase();
    let kind: Video['kind'] = 'video';
    let query = '';
    if (platform === 'tencent') {
      if (host !== 'v.qq.com' || !/^\/x\/(cover\/[a-z\d]+(?:\/[a-z\d]+)?|page\/[a-z\d]+)\.html$/i.test(p)) return;
      if (/\/cover\/[^/]+\.html$/i.test(p)) kind = 'series';
    } else if (platform === 'iqiyi') {
      if (!['www.iqiyi.com', 'iqiyi.com'].includes(host) || !/^\/v_[a-z\d]+\.html$/i.test(p)) return;
    } else if (platform === 'youku') {
      if (host !== 'v.youku.com') return;
      if (p === '/video' || p === '/video/') {
        const vid = u.searchParams.get('vid'), sid = u.searchParams.get('s');
        if (vid && /^[a-z\d=]+$/i.test(vid)) return canonical(`https://v.youku.com/v_show/id_${vid}.html`, platform);
        if (!sid || !/^[a-z\d]+$/i.test(sid)) return;
        query = `?s=${sid}`; kind = 'series';
      } else if (!/^\/v_show\/id_[a-z\d=]+\.html$/i.test(p)) return;
    } else if (platform === 'mango') {
      if (!['www.mgtv.com', 'mgtv.com'].includes(host) || !/^\/b\/\d+\/\d+\.html$/i.test(p)) return;
    } else {
      if (!['www.bilibili.com', 'bilibili.com'].includes(host)) return;
      if (/^\/bangumi\/play\/ss\d+\/?$/i.test(p)) kind = 'series';
      else if (!/^\/(bangumi\/play\/ep\d+|video\/(BV[a-z\d]+|av\d+))\/?$/i.test(p)) return;
    }
    return { url: `https://${PLATFORMS[platform].domain}${p}${query}`, kind };
  } catch { return; }
}

export function video(platform: Platform, query: string, title: unknown, raw: unknown, source: Video['source'] = 'native'): Video | undefined {
  const c = canonical(raw, platform), clean = text(title);
  if (!c || !clean) return;
  return { platform, platform_name: PLATFORMS[platform].name, title: clean, ...c, score: score(query, clean), source };
}
export function ranked(items: Video[]): Video[] {
  const seen = new Map<string, Video>();
  for (const item of items) {
    if (item.score < 0.12) continue;
    const old = seen.get(item.url);
    if (!old || item.score > old.score) seen.set(item.url, item);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, 100);
}
