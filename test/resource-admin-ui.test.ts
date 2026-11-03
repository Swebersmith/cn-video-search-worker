import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { parseHTML } from "linkedom";
import {
  RESOURCE_ADMIN_HTML,
  RESOURCE_ADMIN_JS,
} from "../src/resource-admin-ui";

test("source editor loads, tests and saves a KV snapshot without persisting or disclosing its key", async () => {
  const { window, document } = parseHTML(RESOURCE_ADMIN_HTML);
  const calls: { url: string; init: RequestInit }[] = [];
  const initial = {
    revision: "one",
    storage: "kv",
    sources: [
      {
        id: "jinchan",
        name: "金蝉",
        endpoint: "https://zy.jinchanjiexi.net/api.php/provide/vod/",
        enabled: true,
      },
    ],
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  new Script(RESOURCE_ADMIN_JS).runInNewContext({
    window,
    document,
    AbortSignal,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/check"))
        return Response.json({
          healthy: true,
          checks: [{ name: "search", ok: true }],
          links: { official_page: 1, media: 0, external_page: 0 },
          took_ms: 1,
        });
      if (init.method === "PUT")
        return Response.json({
          ...initial,
          ...JSON.parse(String(init.body)),
          revision: "two",
          updated_at: "2026-11-03T00:00:00Z",
        });
      return Response.json(initial);
    },
  });
  (document.getElementById("admin-key") as any).value = "private-admin-key";
  document
    .getElementById("admin-login")!
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await tick();
  await tick();
  assert.equal(document.querySelectorAll(".source-editor-card").length, 1);
  const card = document.querySelector(".source-editor-card")!;
  card.querySelectorAll("button")[0].dispatchEvent(new window.Event("click"));
  await tick();
  await tick();
  assert.match(card.textContent || "", /验证通过/);
  const fields = card.querySelectorAll("input");
  fields[1].value = "<img src=x onerror=alert(1)>";
  fields[3].checked = false;
  document
    .getElementById("save-config")!
    .dispatchEvent(new window.Event("click"));
  await tick();
  await tick();
  const saved = JSON.parse(
    String(calls.find((c) => c.init.method === "PUT")!.init.body),
  );
  assert.equal(saved.revision, "one");
  assert.equal(saved.sources[0].enabled, false);
  assert.equal(saved.sources[0].name, "<img src=x onerror=alert(1)>");
  assert.equal(document.querySelectorAll("img,iframe").length, 0);
  assert.match(
    document.getElementById("admin-status")!.textContent || "",
    /保存成功/,
  );
  assert.ok(
    calls.every(
      (c) =>
        new Headers(c.init.headers).get("X-Admin-Key") === "private-admin-key",
    ),
  );
  assert.ok(
    calls.every(
      (c) =>
        !c.url.includes("private-admin-key") &&
        !String(c.init.body).includes("private-admin-key"),
    ),
  );
  document.getElementById("logout")!.dispatchEvent(new window.Event("click"));
  assert.equal((document.getElementById("admin-key") as any).value, "");
  assert.equal(document.querySelectorAll(".source-editor-card").length, 0);
  assert.equal((document.getElementById("save-config") as any).disabled, true);
});
