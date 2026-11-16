/**
 * 独立客户端 API 面：Bearer Token、能力发现、CORS、版本协商、机器可读契约。
 * 全部用 Fastify inject，不访问外网。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, upsertWork, type Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const ALLOWED_ORIGIN = "capacitor://localhost";

describe("client api（Bearer Token / meta / CORS / version）", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let workId: number;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-client-api-"));
    const config = loadConfig({
      CONFIG_DIR: join(dir, "config"),
      CACHE_DIR: join(dir, "cache"),
      CORS_ORIGINS: `http://localhost:5173, ${ALLOWED_ORIGIN}`,
    });
    ({ app, db } = await createApp(config));

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
      title: "客户端测试作品",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 5,
    }).id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function createToken(payload: { name: string; scopes?: string[] }) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { cookie },
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: number;
      name: string;
      prefix: string;
      scopes: string[];
      createdAt: string;
      token: string;
    };
  }

  it("创建 Token → Bearer 调用 /api/works → 吊销后 401", async () => {
    const created = await createToken({ name: "手机 App", scopes: ["read", "write"] });
    expect(created.prefix).toMatch(/^nks_[0-9a-f]{8}$/);
    expect(created.token).toMatch(/^nks_[0-9a-f]{8}_[0-9a-f]{64}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const bearer = `Bearer ${created.token}`;

    const works = await app.inject({
      method: "GET",
      url: "/api/works",
      headers: { authorization: bearer },
    });
    expect(works.statusCode).toBe(200);
    const page = works.json() as { items: Array<{ id: number; title: string }>; total: number };
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(workId);
    expect(works.headers["x-api-version"]).toBe("1");

    // 列表不含明文，且 last_used_at 已被刷新
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const tokens = (list.json() as { tokens: Array<Record<string, unknown>> }).tokens;
    const row = tokens.find((item) => item.id === created.id);
    expect(row).toBeTruthy();
    expect(row?.prefix).toBe(created.prefix);
    expect(row?.token).toBeUndefined();
    expect(typeof row?.lastUsedAt).toBe("string");

    // 吊销 → 原 Token 立即失效
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/auth/tokens/${created.id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/works",
      headers: { authorization: bearer },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect((afterRevoke.json() as { error: { code: string } }).error.code).toBe("token_invalid");

    // 已吊销不再出现在列表；重复吊销 404
    const listAfter = await app.inject({ method: "GET", url: "/api/auth/tokens", headers: { cookie } });
    expect(
      (listAfter.json() as { tokens: Array<{ id: number }> }).tokens.some((item) => item.id === created.id),
    ).toBe(false);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/auth/tokens/${created.id}`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("作用域生效：read Token 不能写；admin Token 才能管理 Token", async () => {
    const readToken = await createToken({ name: "TV 只读", scopes: ["read"] });
    const readBearer = `Bearer ${readToken.token}`;

    const read = await app.inject({ method: "GET", url: "/api/works", headers: { authorization: readBearer } });
    expect(read.statusCode).toBe(200);

    const writeAttempt = await app.inject({
      method: "PUT",
      url: `/api/works/${workId}/progress`,
      headers: { authorization: readBearer },
      payload: { page: 2 },
    });
    expect(writeAttempt.statusCode).toBe(403);
    expect((writeAttempt.json() as { error: { code: string } }).error.code).toBe("forbidden");

    // read Token 不能创建新 Token（需要管理员角色 + admin 作用域）
    const escalate = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { authorization: readBearer },
      payload: { name: "越权" },
    });
    expect(escalate.statusCode).toBe(403);

    // 默认作用域为 read
    const defaultScopes = await createToken({ name: "默认作用域" });
    expect(defaultScopes.scopes).toEqual(["read"]);

    // admin Token 可以管理 Token
    const adminToken = await createToken({ name: "管理脚本", scopes: ["admin"] });
    const adminBearer = `Bearer ${adminToken.token}`;
    const viaAdmin = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      headers: { authorization: adminBearer },
      payload: { name: "由 admin Token 创建" },
    });
    expect(viaAdmin.statusCode).toBe(201);
    const createdByToken = viaAdmin.json() as { token: string };
    expect(createdByToken.token).toMatch(/^nks_/);
  });

  it("无效 / 畸形 Token 一律 401，并用 token_invalid 区分于未登录", async () => {
    const unknown = `Bearer nks_deadbeef_${"0".repeat(64)}`;
    const response = await app.inject({
      method: "GET",
      url: "/api/works",
      headers: { authorization: unknown },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe("token_invalid");

    const malformed = await app.inject({
      method: "GET",
      url: "/api/works",
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(malformed.statusCode).toBe(401);
  });

  it("/api/meta 与 /api/openapi.json 公开可访问，能力与版本可读", async () => {
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    expect(meta.statusCode).toBe(200);
    const body = meta.json() as {
      name: string;
      version: string;
      apiVersion: string;
      features: Record<string, boolean>;
      limits: { pageSizeMax: number; uploadMaxMB: number | null };
    };
    expect(body.name).toBe("NekoShelf");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.apiVersion).toBe("1");
    expect(body.features).toMatchObject({ archives: true, video: true, tokens: true });
    expect(body.limits.pageSizeMax).toBe(200);
    expect(body.limits.uploadMaxMB).toBeNull();
    expect(meta.headers["cache-control"]).toContain("public");

    const spec = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.headers["content-type"]).toContain("application/json");
    const document = spec.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi.startsWith("3.1.")).toBe(true);
    for (const path of [
      "/healthz",
      "/api/meta",
      "/api/auth/tokens",
      "/api/auth/tokens/{id}",
      "/api/libraries",
      "/api/jobs/{id}",
      "/api/works",
      "/api/works/{id}/video",
      "/api/scraper",
      "/api/scrape/batch",
    ]) {
      expect(document.paths[path], `OpenAPI 缺少 ${path}`).toBeTruthy();
    }

    // 未登录也能读健康检查
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
  });

  it("CORS_ORIGINS 命中时预检放行，未命中不回 ACAO", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/works",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,x-api-version",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "authorization",
    );

    const disallowed = await app.inject({
      method: "OPTIONS",
      url: "/api/works",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();

    // 实际跨域请求也带 ACAO（凭据模式）
    const actual = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(actual.statusCode).toBe(200);
    expect(actual.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("未配置 CORS_ORIGINS 时不启用 CORS", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "neko-client-api-nocors-"));
    const other = await createApp(
      loadConfig({
        CONFIG_DIR: join(otherDir, "config"),
        CACHE_DIR: join(otherDir, "cache"),
      }),
    );
    try {
      const preflight = await other.app.inject({
        method: "OPTIONS",
        url: "/api/works",
        headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

      const actual = await other.app.inject({
        method: "GET",
        url: "/api/meta",
        headers: { origin: ALLOWED_ORIGIN },
      });
      expect(actual.statusCode).toBe(200);
      expect(actual.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await other.app.close();
      other.db.close();
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("X-API-Version 协商：未知主版本 400，已知版本回带响应头", async () => {
    const unsupported = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { "x-api-version": "2" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect((unsupported.json() as { error: { code: string } }).error.code).toBe(
      "unsupported_api_version",
    );

    const supported = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { "x-api-version": "1" },
    });
    expect(supported.statusCode).toBe(200);
    expect(supported.headers["x-api-version"]).toBe("1");
  });
});
