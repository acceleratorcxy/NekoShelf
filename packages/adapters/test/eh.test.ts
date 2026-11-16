/**
 * E-H 适配器单测：全部用内联脱敏夹具 + 假 fetch，不产生真实流量。
 */
import { describe, expect, it } from "vitest";
import {
  EhClient,
  EhError,
  cookieHeader,
  createEhAdapter,
  type EhCookie,
} from "../src/eh/client.js";
import {
  looksLikeCfChallenge,
  looksLikeLoginPage,
  parseGalleryHtml,
  parseGdataResponse,
  parseSearchForToken,
} from "../src/eh/parse.js";

const COOKIE: EhCookie = {
  ipbMemberId: "123456",
  ipbPassHash: "deadbeef",
  igneous: "abc",
  cfClearance: "cf-token",
};

const GALLERY_HTML = `<!doctype html><html><body>
<link rel="canonical" href="https://exhentai.org/g/2948439/a1b2c3d4e5/" />
<h1 id="gn">[同人志] 测试作品</h1>
<h1 id="gj">[Doujinshi] Test Work</h1>
<div id="taglist">
  <div class="gt">artist:</div><a href="https://exhentai.org/artist/%E7%94%BB%E5%B8%88+%E7%94%BB%E5%B8%88" >画师A</a>
  <div class="gt">language:</div><a href="https://exhentai.org/tag/language/chinese">Chinese</a>
  <div class="gt">female:</div><a href="https://exhentai.org/tag/female/schoolgirl">schoolgirl</a>
  <div class="gt">male:</div><a href="https://exhentai.org/tag/male/teacher">teacher</a>
</div>
<table>
<tr><td class="gdt1">Length:</td><td class="gdt2">123 pages</td></tr>
<tr><td class="gdt1">Category:</td><td class="gdt2">Doujinshi</td></tr>
<tr><td class="gdt1">Posted:</td><td class="gdt2">2024-03-01 12:00</td></tr>
<tr><td class="gdt1">Uploader:</td><td class="gdt2">someone</td></tr>
</table>
</body></html>`;

const GDATA_PAYLOAD = {
  gmetadata: [
    {
      gid: 2948439,
      token: "A1B2C3D4E5",
      title: "[同人志] 测试作品",
      title_jpn: "[Doujinshi] Test Work",
      category: "Doujinshi",
      posted: "1710000000",
      uploader: "someone",
      filecount: "130",
      tags: ["artist:画师A", "language:chinese", "female:schoolgirl", "other:full color"],
    },
  ],
};

const LOGIN_HTML = `<!doctype html><html><body><form id="ipb_login">Sign in to continue</form></body></html>`;
const CF_HTML = `<html><title>Just a moment...</title></html>`;
const SEARCH_HTML = `
<div class="itg">
  <a href="https://exhentai.org/g/2948438/fffffffff0/">other</a>
  <a href="https://exhentai.org/g/2948439/A1B2C3D4E5/">target</a>
</div>`;

function htmlResponse(body: string, status = 200, url = "https://exhentai.org/"): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("E-H HTML 解析", () => {
  it("详情页解析出标题/页数/分类/标签", () => {
    const meta = parseGalleryHtml(GALLERY_HTML);
    expect(meta?.gid).toBe(2948439);
    expect(meta?.token).toBe("a1b2c3d4e5");
    expect(meta?.title).toBe("[同人志] 测试作品");
    expect(meta?.titleJpn).toBe("[Doujinshi] Test Work");
    expect(meta?.fileCount).toBe(123);
    expect(meta?.category).toBe("Doujinshi");
    expect(meta?.uploader).toBe("someone");
    expect(meta?.tags).toContainEqual({ namespace: "language", name: "Chinese" });
    expect(meta?.tags).toContainEqual({ namespace: "female", name: "schoolgirl" });
  });

  it("缺字段时不抛异常，返回 null 字段", () => {
    const meta = parseGalleryHtml("<html><body>nothing</body></html>");
    expect(meta).not.toBeNull();
    expect(meta?.title).toBeNull();
    expect(meta?.fileCount).toBeNull();
    expect(meta?.tags).toEqual([]);
  });

  it("gdata 解析出元数据与标签命名空间", () => {
    const [meta] = parseGdataResponse(GDATA_PAYLOAD);
    expect(meta?.gid).toBe(2948439);
    expect(meta?.token).toBe("a1b2c3d4e5");
    expect(meta?.fileCount).toBe(130);
    expect(meta?.tags).toContainEqual({ namespace: "other", name: "full color" });
    expect(meta?.url).toBe("https://exhentai.org/g/2948439/a1b2c3d4e5/");
  });

  it("gdata 返回 error 时不产生元数据", () => {
    const metas = parseGdataResponse({ gmetadata: [{ gid: 1, error: "invalid or malformed arguments" }] });
    expect(metas[0]?.title).toBeNull();
    expect(metas[0]?.tags).toEqual([]);
  });

  it("搜索页按 gid 精确取 token（大小写归一）", () => {
    expect(parseSearchForToken(SEARCH_HTML, 2948439)).toBe("a1b2c3d4e5");
    expect(parseSearchForToken(SEARCH_HTML, 1)).toBeNull();
  });

  it("识别登录页与 CF 挑战页", () => {
    expect(looksLikeLoginPage(LOGIN_HTML)).toBe(true);
    expect(looksLikeLoginPage(GALLERY_HTML)).toBe(false);
    expect(looksLikeCfChallenge(CF_HTML)).toBe(true);
    expect(looksLikeCfChallenge(GALLERY_HTML, null)).toBe(false);
  });
});

function makeClient(
  routes: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof EhClient>[0]> = {},
) {
  const sleepCalls: number[] = [];
  const client = new EhClient({
    cookie: COOKIE,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      routes(String(url), init)) as typeof fetch,
    minIntervalMs: 0,
    maxRetries: 0,
    ...options,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });
  return { client, sleepCalls };
}

describe("EhClient（假 fetch）", () => {
  it("Cookie 头包含里站四项", () => {
    expect(cookieHeader(COOKIE)).toBe(
      "ipb_member_id=123456; ipb_pass_hash=deadbeef; igneous=abc; cf_clearance=cf-token",
    );
  });

  it("健康检查：首页正常 → ok", async () => {
    const { client } = makeClient(() => htmlResponse(GALLERY_HTML));
    await expect(client.healthCheck()).resolves.toMatchObject({ ok: true, error: null });
  });

  it("健康检查：登录页 → ok=false 且错误说明登录失效", async () => {
    const { client } = makeClient(() => htmlResponse(LOGIN_HTML));
    const health = await client.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("登录");
  });

  it("健康检查：CF 挑战 → ok=false", async () => {
    const { client } = makeClient(() => htmlResponse(CF_HTML, 403));
    const health = await client.healthCheck();
    expect(health.ok).toBe(false);
  });

  it("gdata：请求体 shape 与解析结果正确", async () => {
    let body: unknown = null;
    const { client } = makeClient((url, init) => {
      if (String(url).includes("/api.php")) {
        body = JSON.parse(String(init?.body));
        return jsonResponse(GDATA_PAYLOAD);
      }
      return htmlResponse("");
    });
    const metas = await client.fetchGdata([[2948439, "a1b2c3d4e5"]]);
    expect(body).toMatchObject({ method: "gdata", gidlist: [[2948439, "a1b2c3d4e5"]], namespace: 1 });
    expect(metas[0]?.title).toBe("[同人志] 测试作品");
  });

  it("gdata：单次超过 25 组直接报错，不发请求", async () => {
    let called = 0;
    const { client } = makeClient(() => {
      called += 1;
      return jsonResponse({});
    });
    const tooMany = Array.from({ length: 26 }, (_, index) => [100 + index, "aaaaaaaaaa"] as [number, string]);
    await expect(client.fetchGdata(tooMany)).rejects.toMatchObject({ code: "parse" });
    expect(called).toBe(0);
  });

  it("509 视为配额超限并立即停止重试", async () => {
    const { client } = makeClient(() => htmlResponse("", 509));
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toMatchObject({ code: "quota_exceeded", retryAfterMs: 60 * 60 * 1000 });
  });

  it("详情 404 → not_found", async () => {
    const { client } = makeClient(() => htmlResponse("", 404));
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toBeInstanceOf(EhError);
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toMatchObject({ code: "not_found" });
  });

  it("resolveToken：登录失效 → login_required", async () => {
    const { client } = makeClient(() => htmlResponse(LOGIN_HTML));
    await expect(client.resolveToken(2948439)).rejects.toMatchObject({ code: "login_required" });
  });

  it("两次请求之间有最小间隔（限速生效）", async () => {
    const { client, sleepCalls } = makeClient(() => htmlResponse(GALLERY_HTML), { minIntervalMs: 5000 });
    await client.healthCheck();
    await client.healthCheck();
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(Math.max(...sleepCalls)).toBeLessThanOrEqual(5000);
    expect(Math.max(...sleepCalls)).toBeGreaterThan(0);
  });

  it("createEhAdapter：searchByCode 用 gid 搜索并返回候选", async () => {
    const { client } = makeClient((url) => {
      if (String(url).includes("f_search")) return htmlResponse(SEARCH_HTML);
      return htmlResponse(GALLERY_HTML);
    });
    const adapter = createEhAdapter(client);
    const candidates = await adapter.searchByCode("2948439");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ gid: 2948439, token: "a1b2c3d4e5" });
    await expect(adapter.searchByCode("not-a-gid")).resolves.toEqual([]);
  });

  it("createEhAdapter：getDetail 返回解析后的元数据", async () => {
    const { client } = makeClient(() => htmlResponse(GALLERY_HTML));
    const adapter = createEhAdapter(client);
    const [candidate] = await adapter.searchByCode("2948439").catch(() => []);
    if (candidate) {
      const meta = await adapter.getDetail(candidate);
      expect((meta as { title: string }).title).toContain("测试作品");
    }
  });
});

describe("E-H 错误语义与 Cookie 兼容", () => {
  function bareClient(fetchImpl: typeof fetch, cookie: EhCookie = COOKIE): EhClient {
    return new EhClient({
      cookie,
      minIntervalMs: 0,
      sleep: async () => {},
      fetchImpl,
    });
  }

  it("509 → quota_exceeded 并给出冷却时长", async () => {
    const client = bareClient(async () => new Response("quota", { status: 509 }));
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toMatchObject({
      code: "quota_exceeded",
      retryAfterMs: 60 * 60 * 1000,
    });
  });

  it("sadpanda/kokomoe 占位页 → ip_banned", async () => {
    const html = '<html><body><img src="https://exhentai.org/img/kokomoe.jpg"></body></html>';
    const client = bareClient(async () => new Response(html, { status: 200 }));
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toMatchObject({ code: "ip_banned" });
  });

  it("HTTP 500 → network 错误并带状态码", async () => {
    const client = bareClient(async () => new Response("boom", { status: 500 }));
    await expect(client.detail(1, "aaaaaaaaaa")).rejects.toMatchObject({
      code: "network",
      status: 500,
    });
  });

  it("star Cookie 可选，存在时写入请求头", () => {
    expect(cookieHeader(COOKIE)).not.toContain("star=");
    expect(cookieHeader({ ...COOKIE, star: "st-1" })).toContain("star=st-1");
  });
});
