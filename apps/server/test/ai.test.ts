/**
 * AI 自然语言搜索路由集成测试：Fastify inject + 打桩 fetch，不打真实外网。
 * 覆盖：双重门禁、密钥保存/删除、自然语言→查询语法、结果过滤、错误码映射、健康检查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, setWorkTags, upsertWork, type Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const LLM_PLAN = {
  query: 'tag:猫娘',
  sort: "recent",
  explanation: "找带猫娘标签的作品，按最近更新排序",
};

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AI 搜索路由（ENABLE_LLM_SEARCH=true）", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-ai-"));
    const config = loadConfig({
      CONFIG_DIR: join(dir, "config"),
      CACHE_DIR: join(dir, "cache"),
      ENABLE_LLM_SEARCH: "true",
    });
    ({ app, db } = await createApp(config));

    fetchMock = vi.fn(async () => completion(JSON.stringify(LLM_PLAN)));
    vi.stubGlobal("fetch", fetchMock);

    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "admin", password: "testpass123" },
    });
    expect(setup.statusCode).toBe(201);
    cookie = `sid=${setup.cookies.find((item) => item.name === "sid")?.value}`;

    const library = createLibrary(db, { name: "本子", rootPath: join(dir, "books") });
    const cat = upsertWork(db, {
      libraryId: library.id,
      relativePath: "cat",
      title: "猫娘合订本",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 30,
    });
    setWorkTags(db, cat.id, [
      { namespace: "tag", name: "猫娘" },
      { namespace: "language", name: "chinese" },
    ]);
    const other = upsertWork(db, {
      libraryId: library.id,
      relativePath: "other",
      title: "魔法少女",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 20,
    });
    setWorkTags(db, other.id, [{ namespace: "tag", name: "魔法" }]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function setAi(payload: unknown) {
    return app.inject({ method: "PUT", url: "/api/ai", headers: { cookie }, payload: payload as object });
  }

  function ask(q: string) {
    return app.inject({
      method: "POST",
      url: "/api/ai/query",
      headers: { cookie },
      payload: { q },
    });
  }

  it("初始状态：环境门禁开启、站内开关关闭、未配置密钥", async () => {
    const response = await app.inject({ method: "GET", url: "/api/ai", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ai: Record<string, unknown> };
    expect(body.ai.envGate).toBe(true);
    expect(body.ai.enabled).toBe(false);
    expect(body.ai.configured).toBe(false);
    expect(body.ai.model).toBe("deepseek-chat");
  });

  it("未开启时请求返回 409 ai_disabled（且不调用 LLM）", async () => {
    const response = await ask("找猫娘");
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("保存密钥后自动开启，配置可读回", async () => {
    const response = await setAi({ apiKey: "sk-test-12345678", enabled: true });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ai: { configured: boolean; enabled: boolean } };
    expect(body.ai.configured).toBe(true);
    expect(body.ai.enabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("自然语言 → 查询语法 → 过滤结果", async () => {
    await setAi({ apiKey: "sk-test-12345678", enabled: true });
    const response = await ask("找带猫娘标签的本子");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      query: string;
      explanation: string;
      total: number;
      items: Array<{ id: number; title: string; coverUrl: string; tags: string[] }>;
    };
    expect(body.query).toContain("猫娘");
    expect(body.explanation).toContain("猫娘");
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("猫娘合订本");
    expect(body.items[0]?.coverUrl).toBe(`/api/works/${body.items[0]?.id}/cover`);
    expect(body.items[0]?.tags).toContain("tag:猫娘");

    // 发给 LLM 的请求带上 Bearer 与系统提示
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.deepseek.com/chat/completions");
    expect((call[1].headers as Record<string, string>).authorization).toBe("Bearer sk-test-12345678");
    const payload = JSON.parse(String(call[1].body)) as { messages: Array<{ role: string }> };
    expect(payload.messages[0]?.role).toBe("system");
  });

  it("模型返回非 JSON 时 422 ai_bad_response", async () => {
    await setAi({ apiKey: "sk-test-12345678", enabled: true });
    fetchMock.mockImplementation(async () => completion("抱歉，我不能这样做。"));
    const response = await ask("找点东西");
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ai_bad_response");
  });

  it("密钥无效时 502 ai_llm_auth_failed", async () => {
    await setAi({ apiKey: "sk-test-12345678", enabled: true });
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await ask("找猫娘");
    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ai_llm_auth_failed");
  });

  it("删除密钥后回到未配置状态", async () => {
    await setAi({ apiKey: "sk-test-12345678", enabled: true });
    const del = await app.inject({ method: "DELETE", url: "/api/ai/key", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    const state = del.json() as { ai: { configured: boolean; enabled: boolean } };
    expect(state.ai.configured).toBe(false);
    expect(state.ai.enabled).toBe(false);

    const response = await ask("找猫娘");
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("ai_disabled");
  });

  it("健康检查使用最小请求", async () => {
    await setAi({ apiKey: "sk-test-12345678", enabled: true });
    const response = await app.inject({ method: "POST", url: "/api/ai/health", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { health: { ok: boolean; latencyMs: number } };
    expect(body.health.ok).toBe(true);
    expect(body.health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("AI 门禁（环境变量非必需）", () => {
  it("未开启且无 Key 时返回 409 ai_disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-ai-off-"));
    const config = loadConfig({ CONFIG_DIR: join(dir, "config"), CACHE_DIR: join(dir, "cache") });
    const { app, db } = await createApp(config);
    try {
      const setup = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { username: "admin", password: "testpass123" },
      });
      const cookie = `sid=${setup.cookies.find((item) => item.name === "sid")?.value}`;
      const state = await app.inject({ method: "GET", url: "/api/ai", headers: { cookie } });
      expect((state.json() as { ai: { envGate: boolean } }).ai.envGate).toBe(false);
      const response = await app.inject({
        method: "POST",
        url: "/api/ai/query",
        headers: { cookie },
        payload: { q: "找猫娘" },
      });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe("ai_disabled");
    } finally {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("环境变量关闭时，设置页保存 Key 并开启即可使用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-ai-ui-"));
    const config = loadConfig({ CONFIG_DIR: join(dir, "config"), CACHE_DIR: join(dir, "cache") });
    const { app, db } = await createApp(config);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"query":"tag:language:chinese 猫娘","explanation":"测试"}' } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const setup = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { username: "admin", password: "testpass123" },
      });
      const cookie = `sid=${setup.cookies.find((item) => item.name === "sid")?.value}`;
      const save = await app.inject({
        method: "PUT",
        url: "/api/ai",
        headers: { cookie },
        payload: { apiKey: "sk-ui-test-1234", enabled: true },
      });
      expect(save.statusCode).toBe(200);
      expect((save.json() as { ai: { configured: boolean; enabled: boolean } }).ai.configured).toBe(true);
      const response = await app.inject({
        method: "POST",
        url: "/api/ai/query",
        headers: { cookie },
        payload: { q: "找猫娘" },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { query: string }).query).toContain("猫娘");
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
