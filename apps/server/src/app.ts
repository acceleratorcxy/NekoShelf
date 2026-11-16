import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLibrary, openDatabase, type Db } from "@nekoshelf/core";
import { API_VERSION, dbPath, loadConfig, type AppConfig } from "./config.js";
import { HttpError } from "./media.js";
import { authenticate, setAuthFor, tokenAllows, unauthorizedCodeFor } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAiRoutes, registerClassifyRoutes, registerTranslateRoutes } from "./routes/ai.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerLibraryRoutes } from "./routes/libraries.js";
import { registerTreeRoutes } from "./routes/tree.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerOrganizeRoutes } from "./routes/organize.js";
import { registerPeopleRoutes } from "./routes/people.js";
import { registerScraperRoutes } from "./routes/scraper.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerWorkRoutes } from "./routes/works.js";

/** 不需要鉴权的路径（其余 /api 一律要求会话 Cookie 或 Bearer Token）。 */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/api/setup/status",
  "/api/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/meta",
  "/api/openapi.json",
]);

/** 跨域时允许的请求头/暴露给浏览器的响应头。 */
const CORS_ALLOWED_HEADERS = ["content-type", "authorization", "x-api-version", "if-none-match"];
const CORS_EXPOSED_HEADERS = [
  "x-api-version",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
];

export interface AppContext {
  db: Db;
  config: AppConfig;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] : undefined;
}

function webDistDir(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, "../../web/dist"), // 源码运行：apps/server/src -> apps/web/dist
    resolve(here, "../../../apps/web/dist"), // 构建后：apps/server/dist -> apps/web/dist
    resolve(process.cwd(), "apps/web/dist"),
    resolve(process.cwd(), "web/dist"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

export async function createApp(config: AppConfig = loadConfig()): Promise<{
  app: FastifyInstance;
  db: Db;
}> {
  const db = openDatabase({ path: dbPath(config) });

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);

  // CORS 必须先于鉴权钩子注册：@fastify/cors 自带 onRequest 钩子与 OPTIONS 路由，
  // 预检请求要在业务守卫之前拿到 Access-Control-* 响应头。
  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: (origin, callback) => {
        callback(null, origin !== undefined && config.corsOrigins.includes(origin));
      },
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAge: 600,
      optionsSuccessStatus: 204,
      strictPreflight: false,
    });
  }

  // 鉴权守卫：/api 下除白名单外都要求有效会话 Cookie 或 Bearer Token。
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!path.startsWith("/api/")) return undefined;
    // 预检请求不带凭据，交给 @fastify/cors 处理。
    if (request.method === "OPTIONS") return undefined;

    const requestedVersion = headerValue(request.headers["x-api-version"]);
    if (
      requestedVersion !== undefined &&
      requestedVersion.trim() !== "" &&
      requestedVersion.trim().split(".")[0] !== API_VERSION
    ) {
      return reply.code(400).send({
        error: {
          code: "unsupported_api_version",
          message: `仅支持 API 版本 ${API_VERSION}，请发送 X-API-Version: ${API_VERSION}`,
        },
      });
    }

    if (PUBLIC_PATHS.has(path)) return undefined;

    const auth = authenticate(db, request);
    if (!auth) {
      return reply
        .code(401)
        .send({ error: unauthorizedCodeFor(request) });
    }
    setAuthFor(request, auth);
    if (auth.via === "token" && !tokenAllows(auth.scopes, request.method)) {
      return reply.code(403).send({
        error: { code: "forbidden", message: "该 Token 作用域不足：写操作需要 write，读操作需要 read" },
      });
    }
    return undefined;
  });

  // 所有 /api 响应都带版本号，客户端可据此确认服务端协商结果。
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (path.startsWith("/api/")) reply.header("x-api-version", API_VERSION);
    return payload;
  });

  app.get("/healthz", async () => ({
    ok: true,
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
    db: "ok",
  }));

  registerAuthRoutes(app, db, config);
  registerTokenRoutes(app, db);
  registerClientRoutes(app, config, db);
  registerLibraryRoutes(app, db, config);
  registerTreeRoutes(app, db);
  registerFileRoutes(app, config, (id) => findLibrary(db, id));
  registerWorkRoutes(app, db, config);
  registerScraperRoutes(app, db, config);
  registerAiRoutes(app, db, config);
  registerTranslateRoutes(app, db, config);
  registerClassifyRoutes(app, db, config);
  registerOrganizeRoutes(app, db, config);
  registerPeopleRoutes(app, db);
  registerMaintenanceRoutes(app, db, config);

  // 前端静态资源（存在 dist 才挂载，开发期由 Vite 代理）
  const dist = webDistDir();
  if (dist) {
    await app.register(fastifyStatic, { root: dist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0] ?? request.url;
      if (path.startsWith("/api/") || path === "/healthz" || path.includes(".")) {
        return reply.code(404).send({ error: { code: "not_found", message: "资源不存在" } });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof HttpError
        ? error.status
        : Number((error as { statusCode?: number }).statusCode) || 500;
    const code =
      error instanceof HttpError
        ? error.code
        : status === 400
          ? "validation_failed"
          : status === 401
            ? "unauthorized"
            : status === 403
              ? "forbidden"
              : status === 404
                ? "not_found"
                : "internal";
    if (status >= 500) request.log.error({ error }, "请求失败");
    const message =
      status >= 500 ? "服务器内部错误" : error instanceof Error ? error.message : "请求失败";
    reply.code(status).send({ error: { code, message } });
  });

  return { app, db };
}
