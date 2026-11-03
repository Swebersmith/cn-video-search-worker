import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/index";
import {
  defaultResourceConfig,
  RESOURCE_CONFIG_KEY,
  validateResourceSource,
  validateResourceConfig,
} from "../src/resource-config";
import type { Env, ResourceConfigStore } from "../src/types";

const adminKey = "test-resource-admin-key-at-least-32-characters";
function store(): ResourceConfigStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (k) => values.get(k) ?? null,
    put: async (k, v) => {
      values.set(k, v);
    },
  };
}
const source = {
  id: "custom_1",
  name: "<自定义来源>",
  endpoint: "https://feed.public-site.com/api.php/provide/vod/",
  enabled: true,
};
const req = (path = "", method = "GET", body?: unknown, key = adminKey) =>
  new Request("https://test/v1/admin/resource-sources" + path, {
    method,
    headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("source configuration rejects private, arbitrary, credentialed and duplicate endpoints", () => {
  for (const endpoint of [
    "http://feed.public-site.com/api.php/provide/vod/",
    "https://127.0.0.1/api.php/provide/vod/",
    "https://[::1]/api.php/provide/vod/",
    "https://user:pass@public-site.com/api.php/provide/vod/",
    "https://service.internal/api.php/provide/vod/",
    "https://public-site.com:8443/api.php/provide/vod/",
    "https://public-site.com/anything",
    "https://public-site.com/api.php/provide/vod/?token=secret",
    "https://videosearch.webber.qzz.io/api.php/provide/vod/",
  ])
    assert.throws(
      () => validateResourceSource({ ...source, endpoint }),
      endpoint,
    );
  assert.deepEqual(validateResourceSource(source), source);
  assert.throws(() =>
    validateResourceConfig([source, { ...source, id: "other" }]),
  );
  assert.throws(() =>
    validateResourceConfig([
      source,
      { ...source, endpoint: "https://other-site.com/api.php/provide/vod/" },
    ]),
  );
  assert.throws(() => validateResourceConfig(Array(21).fill(source)));
});

test("admin authentication is independent, fail closed, and never permits cross-origin writes", async () => {
  let calls = 0;
  const h = createHandler(async () => {
    calls++;
    throw Error("unexpected");
  });
  assert.equal((await h(req(), {})).status, 503);
  assert.equal(
    (
      await h(req("", "GET", undefined, "wrong"), {
        RESOURCE_ADMIN_KEY: adminKey,
        API_KEY: "wrong",
      })
    ).status,
    401,
  );
  const cross = req("", "PUT", { sources: [] });
  cross.headers.set("Origin", "https://elsewhere.test");
  assert.equal((await h(cross, { RESOURCE_ADMIN_KEY: adminKey })).status, 403);
  assert.equal(
    (await h(req("?key=secret"), { RESOURCE_ADMIN_KEY: adminKey })).status,
    400,
  );
  const shortKey = "fixture-key..";
  assert.equal((await h(req("", "GET", undefined, shortKey), { RESOURCE_ADMIN_KEY: shortKey })).status, 200);
  assert.equal((await h(req("", "GET", undefined, "too-short"), { RESOURCE_ADMIN_KEY: "too-short" })).status, 503);
  const good = await h(req(), { RESOURCE_ADMIN_KEY: adminKey });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("Cache-Control"), "no-store");
  assert.equal(good.headers.has("Access-Control-Allow-Origin"), false);
  assert.equal(calls, 0);
});

test("KV saves persist through a new handler, replace defaults, and enforce disabled sources on search and detail", async () => {
  const kv = store(),
    env: Env = { RESOURCE_ADMIN_KEY: adminKey, RESOURCE_CONFIG: kv };
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal(new Headers(init?.headers).has("X-Admin-Key"), false);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({
      code: 1,
      page: 1,
      list: [
        {
          vod_id: 17,
          vod_name: "三体",
          vod_play_from: "qq",
          vod_play_url: "第1集$https://v.qq.com/x/cover/show/one.html",
        },
      ],
    });
  };
  const h = createHandler(fetcher),
    initial = (await (await h(req(), env)).json()) as any;
  assert.equal(initial.storage, "kv");
  const sources = [
    source,
    {
      ...source,
      id: "disabled",
      name: "停用",
      endpoint: "https://disabled-site.com/api.php/provide/vod/",
      enabled: false,
    },
  ];
  const saved = await h(
    req("", "PUT", { revision: initial.revision, sources }),
    env,
  );
  assert.equal(saved.status, 200);
  const next = (await saved.json()) as any;
  assert.notEqual(next.revision, initial.revision);
  assert.deepEqual(
    JSON.parse(kv.values.get(RESOURCE_CONFIG_KEY)!).sources,
    sources,
  );
  assert.equal(
    (await h(req("", "PUT", { revision: initial.revision, sources }), env))
      .status,
    409,
  );
  const fresh = createHandler(fetcher);
  const visible = (await (
    await fresh(new Request("https://test/v1/resources"), env)
  ).json()) as any;
  assert.deepEqual(
    visible.sources.map((s: any) => s.id),
    ["custom_1"],
  );
  const result = (await (
    await fresh(new Request("https://test/v1/resources/search?q=三体"), env)
  ).json()) as any;
  assert.equal(result.providers.length, 1);
  assert.equal(result.results[0].source_name, "<自定义来源>");
  const detail = (await (
    await fresh(new Request("https://test/v1/resources/custom_1/items/17"), env)
  ).json()) as any;
  assert.equal(detail.item.id, "17");
  assert.ok(calls.every((u) => u.startsWith(source.endpoint)));
  const count = calls.length;
  for (const path of [
    "/v1/resources/search?q=三体&sources=disabled",
    "/v1/resources/disabled/items/17",
    "/v1/resources/search?q=三体&sources=jinchan",
  ])
    assert.equal(
      (await fresh(new Request("https://test" + path), env)).status,
      400,
    );
  assert.equal(calls.length, count);
  await h(req("", "PUT", { revision: next.revision, sources: [] }), env);
  const empty = (await (
    await fresh(new Request("https://test/v1/resources/search?q=三体"), env)
  ).json()) as any;
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
  assert.equal(calls.length, count);
});

test("invalid or unavailable KV never silently revives defaults; oversized bodies are rejected", async () => {
  const kv = store();
  kv.values.set(RESOURCE_CONFIG_KEY, "broken-json");
  const h = createHandler(),
    env = { RESOURCE_ADMIN_KEY: adminKey, RESOURCE_CONFIG: kv };
  assert.equal(
    (await h(new Request("https://test/v1/resources"), env)).status,
    503,
  );
  assert.equal((await h(req(), env)).status, 503);
  assert.equal(
    (
      await h(req("", "PUT", { sources: [], revision: "defaults-v1" }), {
        RESOURCE_ADMIN_KEY: adminKey,
      })
    ).status,
    503,
  );
  assert.equal(
    (await h(req("", "PUT", { oversized: "x".repeat(66000) }), env)).status,
    413,
  );
  assert.equal(kv.values.get(RESOURCE_CONFIG_KEY), "broken-json");
});

test("source probe verifies detail, negative control and distinct pages without saving or fetching playback", async () => {
  const kv = store();
  const calls: string[] = [];
  const h = createHandler(async (url) => {
    calls.push(url);
    const u = new URL(url),
      q = u.searchParams.get("wd") || "",
      page = Number(u.searchParams.get("pg") || 1);
    assert.equal(u.origin, "https://feed.public-site.com");
    return Response.json({
      code: 1,
      page,
      pagecount: 2,
      total: 2,
      list: q.startsWith("videosearchzz")
        ? []
        : [
            {
              vod_id: page,
              vod_name: q === "的" ? "的作品" : "三体",
              vod_play_from: "qq",
              vod_play_url: "第1集$https://v.qq.com/x/cover/show/one.html",
            },
          ],
    });
  });
  const r = await h(req("/check", "POST", { source, q: "三体" }), {
    RESOURCE_ADMIN_KEY: adminKey,
    RESOURCE_CONFIG: kv,
  });
  const d = (await r.json()) as any;
  assert.equal(d.healthy, true);
  assert.equal(d.checks.length, 4);
  assert.equal(d.links.official_page, 1);
  assert.equal(calls.length, 5);
  assert.equal(kv.values.size, 0);
});
