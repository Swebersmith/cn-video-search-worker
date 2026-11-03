import type { Env } from "./types";

export interface ResourceSourceConfig {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
}
export interface ResourceConfig {
  version: 1;
  revision: string;
  updated_at: string;
  sources: ResourceSourceConfig[];
}
export const RESOURCE_CONFIG_KEY = "resource-sources:v1";
// Default endpoints are independently checked for keyword search, detail and paging.
export const RESOURCE_SOURCES = {
  jinchan: {
    name: "金蝉官采",
    endpoint: "https://zy.jinchanjiexi.net/api.php/provide/vod/",
    enabled: true,
  },
  tw: {
    name: "TW官采",
    endpoint: "https://cj.10010888.xyz/api.php/provide/vod/",
    enabled: true,
  },
  jinying: {
    name: "金鹰资源（第三方媒体）",
    endpoint: "https://jyzyapi.com/provide/vod/",
    enabled: false,
  },
  ruyi: {
    name: "如意资源（第三方媒体）",
    endpoint: "https://cj.rycjapi.com/api.php/provide/vod/",
    enabled: false,
  },
} as const;
export type ResourceSource = string;
export class ResourceConfigError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const validSourceId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(id);
export function validateResourceSource(raw: unknown): ResourceSourceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ResourceConfigError("INVALID_SOURCE", "来源必须是对象。");
  const v = raw as Record<string, unknown>;
  if (!validSourceId(v.id))
    throw new ResourceConfigError(
      "INVALID_SOURCE_ID",
      "来源 ID 需为 2–40 位小写字母、数字、下划线或连字符，以字母开头。",
    );
  if (
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 60 ||
    /[\x00-\x1f\x7f]/.test(v.name)
  )
    throw new ResourceConfigError(
      "INVALID_SOURCE_NAME",
      "名称需为 1–60 字符。",
    );
  if (typeof v.enabled !== "boolean")
    throw new ResourceConfigError("INVALID_ENABLED", "enabled 必须为布尔值。");
  if (typeof v.endpoint !== "string" || v.endpoint.length > 2048)
    throw new ResourceConfigError(
      "INVALID_ENDPOINT",
      "请填写公共 HTTPS MacCMS JSON / XML 采集接口。",
    );
  let u: URL;
  try {
    u = new URL(v.endpoint);
  } catch {
    throw new ResourceConfigError("INVALID_ENDPOINT", "采集接口地址无效。");
  }
  const h = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !h.includes(".") ||
    h.includes(":") ||
    /^[\d.]+$/.test(h) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(
      h,
    ) ||
    h === "videosearch.webber.qzz.io" ||
    h.endsWith(".workers.dev") ||
    !/\/provide\/vod(?:\/[a-z0-9_/-]*)?\/?$/i.test(u.pathname) ||
    [...u.searchParams.keys()].some((k) => !["from", "at"].includes(k))
  )
    throw new ResourceConfigError(
      "INVALID_ENDPOINT",
      "仅支持公共域名上的 HTTPS provide/vod 采集接口；不支持本机、内网、IP、额外端口或含密钥的地址。",
    );
  return {
    id: v.id,
    name: v.name.trim(),
    endpoint: u.href,
    enabled: v.enabled,
  };
}
export function defaultResourceConfig(): ResourceConfig {
  return {
    version: 1,
    revision: "defaults-v1",
    updated_at: "",
    sources: Object.entries(RESOURCE_SOURCES).map(([id, v]) => ({ id, ...v })),
  };
}
export function validateResourceConfig(raw: unknown): ResourceSourceConfig[] {
  if (!Array.isArray(raw) || raw.length > 20)
    throw new ResourceConfigError("INVALID_SOURCES", "最多保存 20 个采集站。");
  const sources = raw.map(validateResourceSource),
    ids = new Set<string>(),
    urls = new Set<string>();
  for (const s of sources) {
    const u = new URL(s.endpoint);
    u.pathname = u.pathname.replace(/\/+$/, "");
    u.searchParams.sort();
    if (ids.has(s.id) || urls.has(u.href))
      throw new ResourceConfigError(
        "DUPLICATE_SOURCE",
        "来源 ID 和接口地址均不能重复。",
      );
    ids.add(s.id);
    urls.add(u.href);
  }
  return sources;
}
export async function loadResourceConfig(env: Env): Promise<ResourceConfig> {
  if (!env.RESOURCE_CONFIG) return defaultResourceConfig();
  try {
    const body = await env.RESOURCE_CONFIG.get(RESOURCE_CONFIG_KEY, {
      cacheTtl: 30,
    });
    if (body === null) return defaultResourceConfig();
    const value = JSON.parse(body) as ResourceConfig;
    if (
      value.version !== 1 ||
      typeof value.revision !== "string" ||
      typeof value.updated_at !== "string"
    )
      throw Error("schema");
    return { ...value, sources: validateResourceConfig(value.sources) };
  } catch {
    throw new ResourceConfigError(
      "RESOURCE_CONFIG_UNAVAILABLE",
      "采集站配置暂时无法读取，请稍后重试。",
      503,
    );
  }
}
export const publicResourceSources = (config: ResourceConfig) =>
  config.sources
    .filter((s) => s.enabled)
    .map((s) => ({
      ...s,
      source: "third_party",
      authorized: null,
      availability: "unchecked",
      search_endpoint: `/v1/resources/search?sources=${s.id}`,
    }));
