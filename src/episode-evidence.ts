import { canonical, text } from './normalize';
import type { Platform } from './types';
import type { EpisodeCandidate } from './ai';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
// Preserve official text, including unfamiliar promotional labels; do not guess access from numeric codes.
export function episodeBadges(v: Obj): string[] {
  const labels: unknown[] = [v.badge, v.tagText, obj(v.mark).text, obj(v.mark).iconfont,
    obj(v.iconCorner).tagText, obj(v.cornerLabelStyle).font, obj(v.corner).text];
  // Current player tags supersede legacy image asset names such as "VIP-包月only-3.0".
  const currentTag = v.uni_imgtag || v.uniImgTag;
  for (const raw of [currentTag || v.imgtag_all]) {
    try { labels.push(...Object.values(typeof raw === 'string' && raw.length < 16000 ? obj(JSON.parse(raw)) : obj(raw)).map(t => obj(t).text)); } catch {}
  }
  for (const raw of [v.corner, v.cornerLabel, v.badges, v.tags]) {
    if (Array.isArray(raw)) labels.push(...raw.filter(t => !/down|bottom/i.test(String(obj(t).area || ''))).map(t => typeof t === 'string' ? t : obj(t).text || obj(t).font));
  }
  // iQiyi supplies the original VIP icon instead of text in its album player API.
  if (typeof v.payMarkUrl === 'string' && /^https?:\/\/[^/]+\.iqiyipic\.com\//i.test(v.payMarkUrl)) {
    if (/\/svip_[^/]+\.(?:png|webp)$/i.test(v.payMarkUrl)) labels.push('SVIP');
    else if (/\/vip_[^/]+\.(?:png|webp)$/i.test(v.payMarkUrl)) labels.push('VIP');
  }
  for (const raw of [v.label, v.c_title_output, v.displayName]) {
    if (typeof raw === 'string' && /^(?:S?VIP|预告|收官礼|超前点映|超前点播|抢先看|提前看|会员试看|付费|限免|免费|会员|大会员)$/i.test(raw.trim())) labels.push(raw);
  }
  return [...new Set(labels.map(text).filter(Boolean))].slice(0, 20);
}
function episodeNumber(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim(),
    match =
      s.match(/^0*(\d{1,4})$/) ||
      s.match(/(?:第\s*)?0*(\d{1,4})\s*[集期话]/) ||
      s.match(/(?:\s|[集期话])0*(\d{1,4})$/);
  const n = match ? Number(match[1]) : 0;
  return n > 0 && n <= 10000 ? n : null;
}
// Input must be scoped by the caller to an exact album/show/season from a verified official response.
// No candidate URL is fetched, and no URL produced by an LLM is ever accepted.
export function episodeCandidates(
  payload: unknown,
  platform: Platform,
  id: string,
  source: string,
): EpisodeCandidate[] {
  const result = new Map<string, EpisodeCandidate>();
  let visited = 0;
  function walk(value: unknown, path: string, title = '', depth = 0, context = '') {
    if (depth > 22 || ++visited > 18000 || result.size >= 600 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, title, depth + 1, context));
      return;
    }
    const v = obj(value);
    const foreign =
      platform === 'youku'
        ? v.showId
        : platform === 'iqiyi'
          ? v.albumId
          : platform === 'tencent'
            ? v.cid
            : platform === 'bilibili'
              ? v.season_id
              : undefined;
    if (
      foreign !== undefined &&
      foreign !== null &&
      String(foreign) !== (platform === 'bilibili' ? id.slice(2) : id)
    )
      return;
    const ownTitle = text(v.play_title || v.title || v.name || v.t2 || v.long_title || v.displayName || v.label) || title;
    const section = [context, v.chapterName, v.section_title].map(text).filter(Boolean).join(' ').slice(0, 350);
    const tags: string[] = [];
    for (const raw of [v.uni_imgtag, v.imgtag_all]) {
      try {
        const parsed = typeof raw === 'string' && raw.length < 16000 ? obj(JSON.parse(raw)) : obj(raw);
        tags.push(...Object.values(parsed).map((tag) => text(obj(tag).text)));
      } catch { /* Malformed optional tags are not evidence. */ }
    }
    const label = [
      v.displayName,
      v.chapterName,
      v.badge,
      obj(v.iconCorner).tagText,
      v.showVideoStage,
      v.t3,
      v.label,
      v.c_title_output,
      v.play_title,
      v.union_title,
      v.title,
      v.name,
      v.long_title,
      v.videoType,
      ...episodeBadges(v),
      v.share_copy,
      section,
      ...tags,
    ]
      .map(text)
      .filter(Boolean)
      .join(' ')
      .slice(0, 350);
    const preview =
      /预告|\b(?:PV|trailer|teaser)\b/i.test(label + ' ' + ownTitle) ||
      v.isTrailer === true ||
      v.isTrailer === 1 ||
      v.isTrailer === '1' ||
      v.is_trailer === true ||
      v.is_trailer === 1 ||
      v.is_trailer === '1';
    const extra =
      /番外|彩蛋|花絮|特辑|加更|纯享|陪看|直拍|精讲|超前营业|特别企划|Reaction/i.test(label + ' ' + ownTitle) ||
      Number(v.peripheryVideoType || 0) !== 0;
    // iQiyi can append interviews/clips with their own ordering to an album response.
    // Their list position is not an episode number in the main series.
    if (platform === 'iqiyi' && v.contentType !== undefined && Number(v.contentType) !== 1 && !preview && !extra) return;
    const n =
      [
        v.orderId,
        v.order,
        v.orderStage,
        v.stage,
        v.t1,
        v.episode_number,
        v.episodeNo,
        v.number,
        v.displayName,
        v.showVideoStage,
        v.label,
        v.c_title_output,
        ownTitle,
      ]
        .map(episodeNumber)
        .find((n) => n !== null) ?? null;
    const urls: unknown[] = [
      v.url,
      v.pageUrl,
      v.playUrl,
      v.share_url,
      v.link,
      v.jumpUrl,
      v.play_url,
      v.page_url,
      v.href,
      v.video_url,
      v.episodeUrl,
      v.web_url,
    ];
    const action = obj(v.action).value;
    // Reject conflicting playback identities before deriving a URL from videoId.
    if (platform === 'youku' && typeof action === 'string' && action) {
      try {
        const u = new URL(action);
        if ((u.searchParams.get('showid') && u.searchParams.get('showid') !== id) ||
            (v.videoId && u.searchParams.get('vid') && u.searchParams.get('vid') !== v.videoId)) return;
      } catch { return; }
    }
    if (typeof action === 'string') {
      try {
        const u = new URL(action);
        if (
          platform === 'youku' &&
          u.protocol === 'youku:' &&
          u.hostname === 'play' &&
          u.searchParams.get('showid') === id
        ) {
          const vid = u.searchParams.get('vid');
          if (vid && /^[a-z\d=]+$/i.test(vid) && (!v.videoId || v.videoId === vid))
            urls.push(`https://v.youku.com/v_show/id_${vid}.html`);
        } else if (u.protocol === 'https:') urls.push(action);
      } catch {
        /* Non-URL actions carry no playback evidence. */
      }
    }
    if (platform === 'youku' && typeof v.videoId === 'string' && /^[a-z\d=]+$/i.test(v.videoId))
      urls.push(`https://v.youku.com/v_show/id_${v.videoId}.html`);
    if (platform === 'tencent' && v.cid === id && typeof v.vid === 'string' && /^[a-z\d]+$/i.test(v.vid))
      urls.push(`https://v.qq.com/x/cover/${id}/${v.vid}.html`);
    for (const raw of urls) {
      const c = canonical(raw, platform);
      if (!c || c.kind === 'series') continue;
      if (platform === 'tencent' && !c.url.includes(`/cover/${id}/`)) continue;
      if (platform === 'mango' && !c.url.includes(`/b/${id.split('-')[0]}/`)) continue;
      if (!ownTitle || (n === null && !preview && !extra)) continue;
      const duration = Number(v.seconds || v.duration);
      const candidate: EpisodeCandidate = {
        badges: episodeBadges(v),
        ref: '',
        url: c.url,
        title: ownTitle,
        label,
        number_hint: n,
        preview,
        extra,
        source: `${source}:${path}`.slice(0, 200),
        duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      };
      const old = result.get(c.url);
      if (!old) result.set(c.url, candidate);
      else {
        old.preview ||= preview;
        old.extra ||= extra;
        old.number_hint ??= n;
        old.badges = [...new Set([...(old.badges || []), ...candidate.badges || []])];
      }
    }
    for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`, ownTitle, depth + 1, section);
  }
  walk(payload, '$');
  return [...result.values()].map((c, i) => ({ ...c, ref: `c${i + 1}` }));
}
