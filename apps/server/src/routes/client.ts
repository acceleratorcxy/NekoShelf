import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getSettingBoolean, type Db } from "@nekoshelf/core";
import { API_VERSION, type AppConfig } from "../config.js";
import { HttpError } from "../media.js";

/** `/api/meta` 的能力声明；客户端据此决定是否显示刮削/视频入口。 */
export interface MetaPayload {
  name: "NekoShelf";
  version: string;
  apiVersion: string;
  features: {
    archives: boolean;
    video: boolean;
    dualLanguage: boolean;
    scraper: boolean;
    tokens: boolean;
  };
  limits: {
    pageSizeMax: number;
    uploadMaxMB: number | null;
  };
}

export const PAGE_SIZE_MAX = 200;

export function metaPayload(config: AppConfig, db?: Db): MetaPayload {
  return {
    name: "NekoShelf",
    version: config.version,
    apiVersion: API_VERSION,
    features: {
      archives: true,
      video: true,
      // 多语言版本（双语标题切换）规划中，本版本不提供。
      dualLanguage: false,
      scraper: db ? getSettingBoolean(db, "scraper.enabled", false) : config.enableScraper,
      tokens: true,
    },
    limits: {
      pageSizeMax: PAGE_SIZE_MAX,
      // 本版本无上传接口（只读源 + 本地挂载），保留字段供后续客户端判断。
      uploadMaxMB: null,
    },
  };
}

/**
 * 契约文件位置：仓库根 `docs/openapi.json`。
 * src/routes 与 dist/routes 距仓库根均为四级；再兜底当前工作目录。
 */
function openApiCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    resolve(here, "../../../../docs/openapi.json"),
    resolve(process.cwd(), "docs/openapi.json"),
  ];
}

let cachedDocument: { path: string; text: string } | undefined;

/** 原样返回 `docs/openapi.json` 文本（只读、进程内缓存）。 */
function loadOpenApiDocument(): { path: string; text: string } {
  if (cachedDocument) return cachedDocument;
  for (const candidate of openApiCandidates()) {
    try {
      const text = readFileSync(candidate, "utf8");
      JSON.parse(text);
      cachedDocument = { path: candidate, text };
      return cachedDocument;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  throw new HttpError(500, "internal", "OpenAPI 契约文件 docs/openapi.json 缺失或不是合法 JSON");
}

function sendJson(reply: FastifyReply, body: string, maxAge: number): FastifyReply {
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("cache-control", `public, max-age=${maxAge}`);
  reply.header("x-content-type-options", "nosniff");
  return reply.send(body);
}

/** 公开的客户端引导接口：`/api/meta`、`/api/openapi.json`（无需鉴权）。 */
export function registerClientRoutes(app: FastifyInstance, config: AppConfig, db?: Db): void {
  app.get("/api/meta", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return metaPayload(config, db);
  });

  app.get("/api/openapi.json", async (_request, reply) => {
    const document = loadOpenApiDocument();
    // 直接回源文本，避免 parse→stringify 破坏手工排版与 JSON Schema 关键字顺序。
    return sendJson(reply, document.text, 600);
  });
}
