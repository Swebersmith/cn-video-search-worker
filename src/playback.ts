import { pageAssignment } from './ssr-data';
import { episodeCandidates } from './episode-evidence';
import { request, UpstreamError } from './providers';
import type { Env, Fetcher, Platform } from './types';
import type { EpisodeCandidate } from './ai';

type Obj = Record<string, any>;
const object = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const array = (v: any): any[] => Array.isArray(v) ? v : [];
function nodes(value: any): Obj[] {
  const found: Obj[] = [], seen = new Set<object>();
  function walk(v: any, depth: number) {
    if (!v || typeof v !== 'object' || depth > 24 || seen.size > 20000 || seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v)) found.push(v);
    Object.values(v).forEach(x => walk(x, depth + 1));
  }
  walk(value, 0); return found;
}
export interface PlaybackCatalogue { candidates: EpisodeCandidate[]; update_notice: string; }

// Parse only the exact show's selection module, never recommendations elsewhere on the page.
export function playbackCatalogue(html: string, platform: Platform, id: string): PlaybackCatalogue {
  let entries: any[] = [], update_notice = '';
  if (platform === 'youku') {
    const data = pageAssignment(html, 'window.__INITIAL_DATA__');
    if (data.pageMap?.extra?.showId !== id) throw new UpstreamError('PLAYBACK_ID_MISMATCH');
    const modules = nodes(data.moduleList).filter(v => v.type === 10013 && Array.isArray(v.itemList));
    update_notice = modules.map(v => v.subtitle || v.moreText || '').filter(Boolean).join(' ');
    entries = modules.flatMap(v => v.itemList).flatMap(v => {
      if (v.action?.extra?.showId !== id || v.action?.type !== 'JUMP_TO_VIDEO' || !/^[a-z\d=]+$/i.test(v.action.value || '')) return [];
      return [{ ...v, showId: id, videoId: v.action.value, orderId: v.stage,
        // Action.value is a video identifier in the PC player, not an H5 URL.
        action: undefined, isTrailer: /预告/.test(v.videoType || '') }];
    });
  } else if (platform === 'tencent') {
    const data = pageAssignment(html, 'window.__PINIA__');
    if (data.global?.currentCid !== id) throw new UpstreamError('PLAYBACK_ID_MISMATCH');
    entries = nodes(data.playlist?.playList?.list).filter(v => v.cid === id && v.vid).map(v => ({
      ...v, play_title: v.playTitle, uni_imgtag: v.uniImgTag, is_trailer: /预告/.test(v.videoType || ''),
    }));
  } else if (platform === 'mango') {
    const data = pageAssignment(html, 'window.__NUXT__');
    const page = array(data.data).find(v => String(v.cid) === id.split('-')[0] && String(v.vid) === id.split('-')[1]);
    if (!page) throw new UpstreamError('PLAYBACK_ID_MISMATCH');
    entries = nodes(page.asideData?.modules).filter(v => v.dataType === 201)
      .flatMap(v => nodes(v.media).filter(item => String(item.clipId) === id.split('-')[0] && /^\d+$/.test(String(item.videoId))))
      .map(v => ({ ...v, url: `https://www.mgtv.com/b/${v.clipId}/${v.videoId}.html` }));
  } else if (platform === 'bilibili') {
    const raw = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    const data = raw ? JSON.parse(raw) : pageAssignment(html, 'window.__INITIAL_STATE__');
    const season = nodes(data).find(v => String(v.season_id) === id.slice(2) && (v.positive || v.episodes));
    if (!season) throw new UpstreamError('PLAYBACK_ID_MISMATCH');
    entries = array(season.episodes).concat(array(season.section).flatMap(v => array(v.episodes)));
  } else {
    // Older and server-rendered iQiyi player variants expose an album-scoped selection.
    const name = ['window.__INITIAL_STATE__', 'window.QiyiPlayerProphetData', 'window.__NEXT_DATA__'].find(n => new RegExp(n.replaceAll('.', '\\.') + '\\s*=').test(html));
    if (!name) throw new UpstreamError('PLAYBACK_DATA_NOT_FOUND');
    const data = pageAssignment(html, name);
    const album = nodes(data).find(v => String(v.albumId ?? v.album_id) === id && (v.epsodelist || v.episodeList));
    if (!album) throw new UpstreamError('PLAYBACK_ID_MISMATCH');
    entries = array(album.epsodelist || album.episodeList);
  }
  return { candidates: episodeCandidates(entries, platform, id, `${platform}_playback_page`), update_notice };
}

export async function loadPlaybackCatalogue(platform: Platform, id: string, playUrl: string, env: Env, fetcher: Fetcher) {
  const url = platform === 'tencent' ? `https://m.v.qq.com/x/m/play?cid=${id}`
    : platform === 'bilibili' ? `https://www.bilibili.com/bangumi/play/${id}` : playUrl;
  const html = await request(url, env, fetcher, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } });
  return playbackCatalogue(html, platform, id);
}
