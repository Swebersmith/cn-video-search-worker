import { PLATFORMS, type Platform } from './types';

export const DEFAULT_VIEW = 'series' as const;
export const VERSION = '2.3.2';
export const CAPABILITIES = Object.fromEntries(
  Object.entries(PLATFORMS).map(([id, p]) => [
    id,
    {
      id,
      name: p.name,
      domain: p.domain,
      endpoint: `/v1/${id}/search`,
      search: true,
      series: true,
      episodes: true,
      detail_endpoint: `/v1/${id}/series/{id}`,
      note: id === 'bilibili'
        ? '仅查询影视（media_ft）和番剧（media_bangumi），不收录普通投稿、用户或直播。'
        : '影视目录仅收录电影、电视剧、综艺、动漫、纪录片等长内容，AI 辅助分类及分集识别。',
    },
  ]),
) as Record<
  Platform,
  {
    id: string;
    name: string;
    domain: string;
    endpoint: string;
    search: boolean;
    series: boolean;
    episodes: boolean;
    detail_endpoint: string;
    note: string;
  }
>;
