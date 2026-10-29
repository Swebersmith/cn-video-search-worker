import { PLATFORMS, type Platform } from './types';

export const VERSION = '2.0.1';
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
      note: '官网综合搜索保留原始卡片；影视目录仅收录电影、电视剧、综艺、动漫、纪录片等长内容，AI 辅助分类及分集识别。',
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
