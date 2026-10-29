export const PLATFORMS = {
  tencent: { name: '腾讯视频', domain: 'v.qq.com', search: 'https://v.qq.com/x/search/?q=' },
  iqiyi: { name: '爱奇艺', domain: 'www.iqiyi.com', search: 'https://so.iqiyi.com/so/q_' },
  youku: { name: '优酷', domain: 'v.youku.com', search: 'https://search.youku.com/search_video?keyword=' },
  mango: { name: '芒果 TV', domain: 'www.mgtv.com', search: 'https://so.mgtv.com/so?k=' },
  bilibili: { name: '哔哩哔哩', domain: 'www.bilibili.com', search: 'https://search.bilibili.com/all?keyword=' },
} as const;
export type Platform = keyof typeof PLATFORMS;
export interface Env {
  API_KEY?: string;
  BILIBILI_GATEWAY_URL?: string;
  BILIBILI_GATEWAY_TOKEN?: string;
  CORS_ORIGIN?: string;
  CACHE_TTL_SECONDS?: string;
  STALE_TTL_SECONDS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}
export interface Video {
  platform: Platform;
  platform_name: string;
  title: string;
  url: string;
  kind: 'video' | 'series';
  score: number;
  source: 'native';
}
export interface ProviderResult {
  platform: Platform;
  status: 'ok' | 'empty' | 'degraded' | 'unavailable' | 'stale';
  results: Video[];
  warnings: string[];
  cached: boolean;
  fetched_at: string;
  search_url: string;
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface CacheStore {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, value: Response): Promise<void>;
}
export function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
