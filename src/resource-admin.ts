import type { Env, Fetcher } from "./types";
import {
  loadResourceConfig,
  validateResourceConfig,
  validateResourceSource,
  ResourceConfigError,
  RESOURCE_CONFIG_KEY,
} from "./resource-config";
import { searchResource } from "./resources";

async function authenticated(request: Request, key: string): Promise<boolean> {
  const supplied =
    request.headers.get("X-Admin-Key") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (supplied.length > 1024) return false;
  const hashes = await Promise.all(
    [supplied, key].map((s) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
  const a = new Uint8Array(hashes[0]),
    b = new Uint8Array(hashes[1]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ResourceConfigError(
      "INVALID_CONTENT_TYPE",
      "请使用 application/json。",
      415,
    );
  if (Number(request.headers.get("Content-Length")) > 65536)
    throw new ResourceConfigError(
      "BODY_TOO_LARGE",
      "配置请求超过 64 KiB。",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader) throw new ResourceConfigError("EMPTY_BODY", "缺少请求体。");
  const decoder = new TextDecoder();
  let body = "",
    size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new ResourceConfigError(
        "BODY_TOO_LARGE",
        "配置请求超过 64 KiB。",
        413,
      );
    }
    body += decoder.decode(part.value, { stream: true });
  }
  try {
    const v: unknown = JSON.parse(body + decoder.decode());
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ResourceConfigError("INVALID_JSON", "请求体必须是 JSON 对象。");
  }
}
export async function handleResourceAdmin(
  request: Request,
  env: Env,
  fetcher: Fetcher,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.replace(/\/+$/, "");
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  const fail = (code: string, message: string, status: number) =>
    reply({ ok: false, error: { code, message } }, status);
  if (
    request.headers.get("Origin") &&
    request.headers.get("Origin") !== url.origin
  )
    return fail("ORIGIN_NOT_ALLOWED", "请从当前域名的管理页面访问。", 403);
  if (!env.RESOURCE_ADMIN_KEY || env.RESOURCE_ADMIN_KEY.length < 12)
    return fail("ADMIN_NOT_CONFIGURED", "管理员密钥尚未配置。", 503);
  if (!(await authenticated(request, env.RESOURCE_ADMIN_KEY)))
    return fail("UNAUTHORIZED", "管理密钥无效。", 401);
  if (url.search)
    return fail(
      "INVALID_PARAMETER",
      "管理接口不接受 URL 参数或 URL 密钥。",
      400,
    );
  if (
    ![
      "/v1/admin/resource-sources",
      "/v1/admin/resource-sources/check",
    ].includes(path)
  )
    return fail("NOT_FOUND", "管理接口不存在。", 404);
  try {
    if (path.endsWith("/check")) {
      if (request.method !== "POST")
        return fail("METHOD_NOT_ALLOWED", "使用 POST 测试来源。", 405);
      const body = await readBody(request),
        source = validateResourceSource(body.source);
      const query = typeof body.q === "string" ? body.q.trim() : "三体";
      if (!query || query.length > 80 || /[\x00-\x1f\x7f]/.test(query))
        throw new ResourceConfigError(
          "INVALID_QUERY",
          "测试片名需为 1–80 字符。",
        );
      const start = Date.now(),
        search = await searchResource(
          source.id,
          query,
          1,
          env,
          fetcher,
          undefined,
          source,
        );
      const checks: {
        name: string;
        ok: boolean;
        count?: number;
        warnings?: string[];
      }[] = [
        {
          name: "search",
          ok: search.status === "ok",
          count: search.count,
          warnings: search.warnings,
        },
      ];
      let links = 0,
        official = 0,
        media = 0,
        external = 0;
      if (search.results.length) {
        const id = search.results[0].id;
        const [detail, negative, broad] = await Promise.all([
          searchResource(source.id, "", 1, env, fetcher, id, source),
          searchResource(
            source.id,
            "videosearchzz" + crypto.randomUUID().replace(/-/g, ""),
            1,
            env,
            fetcher,
            undefined,
            source,
          ),
          searchResource(source.id, "的", 1, env, fetcher, undefined, source),
        ]);
        const entries =
          detail.results[0]?.lines.flatMap((l) => [
            ...l.episodes,
            ...l.previews,
          ]) || [];
        links = entries.length;
        official = entries.filter(
          (e) => e.link_type === "official_page",
        ).length;
        media = entries.filter((e) => e.link_type === "media").length;
        external = entries.filter(
          (e) => e.link_type === "external_page",
        ).length;
        checks.push({
          name: "detail",
          ok:
            detail.status === "ok" && detail.results[0]?.id === id && links > 0,
          count: links,
          warnings: detail.warnings,
        });
        checks.push({
          name: "keyword_filter",
          ok: negative.status === "empty" && negative.count === 0,
          warnings: negative.warnings,
        });
        if (broad.status === "ok" && (broad.pagecount || 0) > 1) {
          const next = await searchResource(
            source.id,
            "的",
            2,
            env,
            fetcher,
            undefined,
            source,
          );
          checks.push({
            name: "pagination",
            ok:
              next.status === "ok" &&
              next.page === 2 &&
              next.results.some(
                (v) => !broad.results.some((w) => v.id === w.id),
              ),
            count: next.count,
            warnings: next.warnings,
          });
        } else
          checks.push({
            name: "pagination",
            ok: false,
            warnings: ["PAGINATION_NOT_VERIFIED", ...broad.warnings],
          });
      }
      return reply({
        ok: true,
        healthy: checks.length === 4 && checks.every((c) => c.ok),
        checked_at: new Date().toISOString(),
        source_id: source.id,
        query,
        checks,
        links: {
          total: links,
          official_page: official,
          media,
          external_page: external,
        },
        took_ms: Date.now() - start,
      });
    }
    if (request.method === "GET") {
      const config = await loadResourceConfig(env);
      return reply({
        ok: true,
        storage: env.RESOURCE_CONFIG ? "kv" : "defaults",
        ...config,
        propagation_note:
          "KV 保存后其他地区通常在 30–60 秒内同步；同一管理页面使用保存响应中的新配置。",
      });
    }
    if (request.method !== "PUT")
      return fail(
        "METHOD_NOT_ALLOWED",
        "使用 GET 读取或 PUT 保存来源配置。",
        405,
      );
    if (!env.RESOURCE_CONFIG)
      throw new ResourceConfigError(
        "RESOURCE_CONFIG_NOT_BOUND",
        "尚未绑定 Cloudflare KV，未保存任何配置。",
        503,
      );
    const body = await readBody(request),
      sources = validateResourceConfig(body.sources),
      current = await loadResourceConfig(env);
    if (body.revision !== current.revision)
      throw new ResourceConfigError(
        "CONFIG_CHANGED",
        "配置已变更，请重新读取后再保存。",
        409,
      );
    const config = {
      version: 1 as const,
      revision: crypto.randomUUID(),
      updated_at: new Date().toISOString(),
      sources,
    };
    await env.RESOURCE_CONFIG.put(RESOURCE_CONFIG_KEY, JSON.stringify(config));
    return reply({ ok: true, storage: "kv", ...config });
  } catch (e) {
    if (e instanceof ResourceConfigError)
      return fail(e.code, e.message, e.status);
    return fail(
      "ADMIN_OPERATION_FAILED",
      "操作暂时失败，未确认保存成功，请重新读取配置核对。",
      503,
    );
  }
}
