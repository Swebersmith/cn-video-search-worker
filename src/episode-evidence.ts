import { canonical, text } from './normalize';
import type { Platform } from './types';
import type { EpisodeCandidate } from './ai';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
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
      /番外|彩蛋|花絮|特辑|加更|纯享|陪看|直拍|精讲/.test(label + ' ' + ownTitle) ||
      Number(v.peripheryVideoType || 0) !== 0;
    const n =
      [
        v.orderId,
        v.order,
        v.orderStage,
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
      }
    }
    for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`, ownTitle, depth + 1, section);
  }
  walk(payload, '$');
  return [...result.values()].map((c, i) => ({ ...c, ref: `c${i + 1}` }));
}
