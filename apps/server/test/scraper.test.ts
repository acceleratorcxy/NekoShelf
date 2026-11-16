/**
 * E-H 刮削路由集成测试：用 Fastify inject + 打桩 fetch，不打真实外网。
 * 覆盖：环境门禁、Cookie 保存/清除、健康检查、单条刮削、已刮/已禁用返回码、缓存命中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, findWork, upsertWork, type Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const GID = 2948439;
const TOKEN = "abcdef1234";

const SEARCH_HTML = `<html><body><a href="/g/${GID}/${TOKEN}/">結果</a></body></html>`;

const GALLERY_HTML = `<html><body>
<h1 id="gn">テスト画廊</h1>
<h1 id="gj">测试标题</h1>
<div id="gdc"><div>uploader</div><div>2024-05-01 12:00</div></div>
<div id="gdd"><div><table><tr><td class="gdt1">Length:</td><td class="gdt2">120 pages</td></tr></table></div></div>
<div id="taglist">
  <div class="gt">language:</div><a href="https://exhentai.org/tag/language/chinese">chinese</a>
  <div class="gt">artist:</div><a href="https://exhentai.org/tag/artist/test">测试作者</a>
  <div class="gt">group:</div><a href="https://exhentai.org/tag/group/testsite">测试社团</a>
</div>
<table>
<tr><td class="gdt1">Length:</td><td class="gdt2">120 pages</td></tr>
<tr><td class="gdt1">Category:</td><td class="gdt2">Doujinshi</td></tr>
<tr><td class="gdt1">Posted:</td><td class="gdt2">2024-05-01 12:00</td></tr>
<tr><td class="gdt1">Uploader:</td><td class="gdt2">uploader</td></tr>
</table>
</body></html>`;

const HOME_HTML = `<html><body><div id="gb">gallery home</div></body></html>`;

const GDATA = {
  gmetadata: [
    {
      gid: GID,
      token: TOKEN,
      title: "テスト画廊",
      title_jpn: "测试标题",
      category: "Doujinshi",
      thumb: "https://ehgt.org/1/2/3.jpg",
      uploader: "uploader",
      posted: "1714560000",
      filecount: "120",
      rating: "4.5",
      tags: ["language:chinese", "artist:test", "group:testsite"],
    },
  ],
};

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.php")) {
      return new Response(JSON.stringify(GDATA), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("f_search=")) {
      return new Response(SEARCH_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.includes("/g/")) {
      return new Response(GALLERY_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

describe("scraper routes（ENABLE_SCRAPER=true）", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let workId: number;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-scraper-"));
    const config = loadConfig({
      CONFIG_DIR: join(dir, "config"),
      CACHE_DIR: join(dir, "cache"),
      ENABLE_SCRAPER: "true",
    });
    ({ app, db } = await createApp(config));
    stubFetch();

    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "admin", password: "testpass123" },
    });
    expect(setup.statusCode).toBe(201);
    const sid = setup.cookies.find((item) => item.name === "sid")?.value;
    expect(sid).toBeTruthy();
    cookie = `sid=${sid}`;

    const library = createLibrary(db, { name: "本子", rootPath: join(dir, "books") });
    workId = upsertWork(db, {
      libraryId: library.id,
      relativePath: "work-a",
      title: "本地目录名",
      kind: "comic",
      sourceKind: "directory",
      gid: GID,
      pageCount: 5,
      hasComicInfo: false,
    }).id;
  });

  async function addWork(relativePath: string, title: string, gid: number): Promise<number> {
    const rootPath = join(dir, "books");
    const existing = db
      .prepare("SELECT id FROM libraries WHERE root_path = ?")
      .get(rootPath) as { id: number } | undefined;
    const libraryId = existing?.id ?? createLibrary(db, { name: "本子", rootPath }).id;
    return upsertWork(db, {
      libraryId,
      relativePath,
      title,
      kind: "comic",
      sourceKind: "directory",
      gid,
      pageCount: 5,
      hasComicInfo: false,
    }).id;
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function putScraper(payload: unknown) {
    return app.inject({ method: "PUT", url: "/api/scraper", headers: { cookie }, payload: payload as object });
  }

  it("初始状态：环境变量不再强制开启、无凭据", async () => {
    const response = await app.inject({ method: "GET", url: "/api/scraper", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { scraper: { enabled: boolean; envGate: boolean; hasCredential: boolean } };
    expect(body.scraper.envGate).toBe(true);
    expect(body.scraper.enabled).toBe(false);
    expect(body.scraper.hasCredential).toBe(false);
  });

  it("未启用时单条刮削返回 409 scraper_disabled", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${workId}`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("scraper_disabled");
  });

  it("保存 Cookie → 健康检查 → 单条刮削回写元数据", async () => {
    const saved = await putScraper({
      enabled: true,
      minIntervalMs: 2000,
      cookie: { ipbMemberId: "123", ipbPassHash: "hash", igneous: "ign" },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { scraper: { enabled: boolean; hasCredential: boolean } }).scraper.hasCredential).toBe(true);

    const health = await app.inject({ method: "POST", url: "/api/scraper/health", headers: { cookie }, payload: {} });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { health: { ok: boolean } }).health.ok).toBe(true);

    const scraped = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${workId}`,
      headers: { cookie },
      payload: {},
    });
    expect(scraped.statusCode).toBe(200);
    const applied = (scraped.json() as { applied: { title: string; pageCount: number | null; tagCount: number; cached: boolean } }).applied;
    expect(applied.title).toBe("テスト画廊");
    expect(applied.pageCount).toBe(120);
    expect(applied.tagCount).toBe(3);
    expect(applied.cached).toBe(false);

    const detail = await app.inject({ method: "GET", url: `/api/works/${workId}`, headers: { cookie } });
    const work = (detail.json() as { work: { title: string; pageCount: number; tags: Array<{ namespace: string; name: string }>; hasComicInfo: boolean } }).work;
    expect(work.title).toBe("テスト画廊");
    expect(work.pageCount).toBe(120);
    expect(work.hasComicInfo).toBe(true);
    expect(work.tags).toEqual(expect.arrayContaining(["language:chinese", "artist:测试作者"]));
  });

  it("已有元数据再次刮削返回 409 already_scraped，force 时走缓存", async () => {
    await putScraper({ enabled: true, minIntervalMs: 2000, cookie: { ipbMemberId: "123", ipbPassHash: "hash", igneous: "ign" } });
    const first = await app.inject({ method: "POST", url: `/api/scrape/works/${workId}`, headers: { cookie }, payload: {} });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/api/scrape/works/${workId}`, headers: { cookie }, payload: {} });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe("already_scraped");

    const forced = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${workId}`,
      headers: { cookie },
      payload: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect((forced.json() as { applied: { cached: boolean } }).applied.cached).toBe(true);
  });

  it("批量只处理候选，且可清除凭据", async () => {
    await putScraper({ enabled: true, minIntervalMs: 2000, cookie: { ipbMemberId: "123", ipbPassHash: "hash", igneous: "ign" } });
    const added = createLibrary(db, { name: "另一库", rootPath: join(dir, "books2") });
    upsertWork(db, {
      libraryId: added.id,
      relativePath: "work-b",
      title: "另一个",
      kind: "comic",
      sourceKind: "directory",
      gid: GID + 1,
      pageCount: 5,
      hasComicInfo: false,
    });

    const batch = await app.inject({
      method: "POST",
      url: "/api/scrape/batch",
      headers: { cookie },
      payload: { limit: 1 },
    });
    expect(batch.statusCode).toBe(202);
    const queued = batch.json() as { jobId: string | null; candidates: number };
    expect(queued.candidates).toBe(1);
    expect(queued.jobId).toBeTruthy();

    let job = { state: "", progress: { done: 0, total: 0 }, message: null as string | null };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/jobs/${queued.jobId}`, headers: { cookie } });
      job = (response.json() as { job: typeof job }).job;
      if (job.state === "done" || job.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(job.state).toBe("done");
    expect(job.progress).toEqual({ done: 1, total: 1 });

    const clear = await app.inject({ method: "DELETE", url: "/api/scraper/cookie", headers: { cookie } });
    expect(clear.statusCode).toBe(200);
    const state = await app.inject({ method: "GET", url: "/api/scraper", headers: { cookie } });
    expect((state.json() as { scraper: { hasCredential: boolean } }).scraper.hasCredential).toBe(false);

    const afterClear = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${workId}`,
      headers: { cookie },
      payload: { force: true },
    });
    expect(afterClear.statusCode).toBe(409);
    expect((afterClear.json() as { error: { code: string } }).error.code).toBe("scraper_disabled");
  });
  it(".ehviewer 命中链路①：本地 token 跳过站内搜索", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.php")) {
        return new Response(JSON.stringify(GDATA), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/g/")) {
        return new Response(GALLERY_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    const target = await addWork("work-local", "本地目录名 2", 1234567);
    const workDir = join(dir, "books", "work-local");
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(workDir, ".ehviewer"),
      ["VERSION2", "00000002 startPage", "1234567", "feedfacecafe1234", "4", "5"].join("\n"),
    );

    const saved = await putScraper({
      enabled: true,
      minIntervalMs: 2000,
      cookie: { ipbMemberId: "123", ipbPassHash: "hash", igneous: "ign" },
    });
    expect(saved.statusCode).toBe(200);

    const scraped = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${target}`,
      headers: { cookie },
      payload: {},
    });
    expect(scraped.statusCode).toBe(200);
    expect((scraped.json() as { applied: { title: string } }).applied.title).toBe("テスト画廊");
    // 直接用 .ehviewer 的 token 抓详情，不应发起站内搜索
    expect(calls.some((url) => url.includes("f_search="))).toBe(false);
    expect(calls.some((url) => url.includes("/g/1234567/feedfacecafe1234/"))).toBe(true);
    expect(findWork(db, target)?.page_count).toBe(120);
  });

  it("509 配额超限 → 429 并进入冷却，冷却期内再次刮削直接拒绝", async () => {
    vi.stubGlobal("fetch", async () => new Response("quota", { status: 509 }));
    const target = await addWork("work-509", "配额测试", 424242);
    const saved = await putScraper({
      enabled: true,
      minIntervalMs: 2000,
      cookie: { ipbMemberId: "123", ipbPassHash: "hash", igneous: "ign" },
    });
    expect(saved.statusCode).toBe(200);

    const first = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${target}`,
      headers: { cookie },
      payload: {},
    });
    expect(first.statusCode).toBe(429);
    expect((first.json() as { error: { code: string } }).error.code).toBe("quota_exceeded");

    const state = await app.inject({ method: "GET", url: "/api/scraper", headers: { cookie } });
    expect((state.json() as { scraper: { cooldownMs: number } }).scraper.cooldownMs).toBeGreaterThan(0);

    const second = await app.inject({
      method: "POST",
      url: `/api/scrape/works/${target}`,
      headers: { cookie },
      payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect((second.json() as { error: { code: string } }).error.code).toBe("cooldown");
  });
});

describe("scraper routes（ENABLE_SCRAPER 未设置）", () => {
  it("环境变量未设置时，设置页开关仍可启用（无 Cookie 时刮削报错）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-scraper-off-"));
    const config = loadConfig({ CONFIG_DIR: join(dir, "config"), CACHE_DIR: join(dir, "cache") });
    const { app, db } = await createApp(config);

    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "u", password: "testpass123" } });
    const sid = setup.cookies.find((item) => item.name === "sid")?.value;
    const cookie = `sid=${sid}`;

    const state = await app.inject({ method: "GET", url: "/api/scraper", headers: { cookie } });
    expect((state.json() as { scraper: { envGate: boolean; enabled: boolean } }).scraper).toMatchObject({
      envGate: false,
      enabled: false,
    });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/scraper",
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect((enabled.json() as { scraper: { enabled: boolean } }).scraper.enabled).toBe(true);

    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

});
