/**
 * 自然语言搜索（AI 搜索）路由。
 *
 * 设计要点：
 * - 默认 DeepSeek（OpenAI 兼容），也支持任意兼容网关；
 * - LLM 只把自然语言翻译成 NekoShelf 已有的查询语法，**不做**向量检索，结果永远可被用户复现/手动修改；
 * - 双重门禁：环境变量 `ENABLE_LLM_SEARCH=true`（硬开关，防误触发外网请求）+ 设置页开关；
 * - 密钥加密存 DB（复用 `source_credentials`，source = "llm"），环境变量 `LLM_API_KEY` 作为兜底；
 * - 出错给结构化错误码（ai_llm_auth_failed / ai_llm_rate_limited / ai_bad_response …），前端可直接展示。
 */
import type { FastifyInstance } from "fastify";
import {
  addAuditLog,
  buildNlSearchMessages,
  findWork,
  setTitleZh,
  updateWorkKind,
  countWorksInLibrary,
  getSetting,
  getSettingBoolean,
  listLibraries,
  listTags,
  listWorks,
  parseNlSearchPlan,
  planSort,
  queryHasFilters,
  sanitizeQueryText,
  setSetting,
  upsertSourceCredential,
  deleteSourceCredential,
  findSourceCredential,
  type Db,
  type NlSearchPlan,
  type WorkRow,
} from "@nekoshelf/core";
import { LlmClient, LlmError, type AdapterHealth } from "@nekoshelf/adapters";
import { decryptJson, encryptJson, loadMasterKey } from "../crypto.js";
import type { AppConfig } from "../config.js";

const SOURCE = "llm";
const SETTING_ENABLED = "ai.enabled";
const SETTING_MODEL = "ai.model";
const SETTING_BASE_URL = "ai.base_url";
const SETTING_EXPLAIN = "ai.explain";
const SETTING_SUMMARY = "ai.summary";

interface LlmSecret {
  apiKey?: string;
}

interface AiStateResponse {
  ai: {
    enabled: boolean;
    envGate: boolean;
    configured: boolean;
    /** 已保存 Key 的掩码提示（仅末 4 位），便于确认“保存成功”。 */
    apiKeyHint: string | null;
    classifyEnabled: boolean;
    model: string;
    baseUrl: string;
    explain: boolean;
    summarize: boolean;
    usage: { requests: number };
  };
}

function readSecret(config: AppConfig, db: Db): LlmSecret {
  const envKey = config.llm.envApiKey;
  const row = findSourceCredential(db, SOURCE);
  if (row) {
    try {
      const secret = decryptJson<LlmSecret>(loadMasterKey(config.configDir), row.payload);
      if (secret.apiKey) return secret;
    } catch {
      // 主密钥变化/数据损坏时退回环境变量
    }
  }
  return envKey ? { apiKey: envKey } : {};
}

function settingBool(db: Db, key: string, fallback: boolean): boolean {
  return getSettingBoolean(db, key, fallback);
}

function stateOf(config: AppConfig, db: Db): AiStateResponse["ai"] {
  const secret = readSecret(config, db);
  const requests = Number(getSetting(db, "ai.usage_requests") ?? "0");
  return {
    enabled: settingBool(db, SETTING_ENABLED, false),
    envGate: config.llm.envEnabled,
    configured: Boolean(secret.apiKey),
    apiKeyHint: secret.apiKey ? `…${secret.apiKey.slice(-4)}` : null,
    classifyEnabled: settingBool(db, CLASSIFY_SETTING, false),
    model: getSetting(db, SETTING_MODEL) ?? config.llm.defaultModel,
    baseUrl: getSetting(db, SETTING_BASE_URL) ?? config.llm.baseUrl,
    explain: settingBool(db, SETTING_EXPLAIN, true),
    summarize: settingBool(db, SETTING_SUMMARY, true),
    usage: { requests: Number.isFinite(requests) ? requests : 0 },
  };
}

type AiGate = { status: number; code: string; message: string };

/**
 * AI 门禁：设置页开关即可启用；环境变量 ENABLE_LLM_SEARCH=true 仅作为「无 UI 时的强制开启」。
 * - 未开启（开关关且环境变量未开）→ ai_disabled
 * - 已开启但没有 Key（设置页未填、环境变量也没有）→ ai_no_key
 */
function gateOf(config: AppConfig, db: Db): AiGate | null {
  const state = stateOf(config, db);
  if (!state.enabled) {
    return {
      status: 409,
      code: "ai_disabled",
      message: "AI 未开启：在设置页填写 API Key 并打开「开启 AI 搜索」开关即可（不需要改环境变量）",
    };
  }
  if (!state.configured) {
    return {
      status: 409,
      code: "ai_no_key",
      message: "未配置 API Key：请在设置页「AI 自然语言搜索」里填入 DeepSeek API Key",
    };
  }
  return null;
}

function bumpUsage(db: Db): void {
  const current = Number(getSetting(db, "ai.usage_requests") ?? "0");
  setSetting(db, "ai.usage_requests", String(Number.isFinite(current) ? current + 1 : 1));
}

function makeClient(config: AppConfig, db: Db): LlmClient {
  const secret = readSecret(config, db);
  if (!secret.apiKey) throw new LlmError("auth_failed", "未配置 DeepSeek API Key");
  return new LlmClient({
    apiKey: secret.apiKey,
    baseUrl: stateOf(config, db).baseUrl,
    model: stateOf(config, db).model,
    timeoutMs: config.llm.timeoutMs,
  });
}

/** LLM 错误 → HTTP 状态与错误码。 */
function llmErrorToHttp(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof LlmError) {
    switch (error.code) {
      case "auth_failed":
        return { status: 502, code: "ai_llm_auth_failed", message: error.message };
      case "model_not_found":
        return { status: 502, code: "ai_llm_model_not_found", message: error.message };
      case "rate_limited":
        return { status: 429, code: "ai_llm_rate_limited", message: error.message };
      case "timeout":
        return { status: 504, code: "ai_llm_timeout", message: error.message };
      case "network":
        return { status: 502, code: "ai_llm_network", message: error.message };
      default:
        return { status: 502, code: "ai_bad_response", message: error.message };
    }
  }
  return { status: 502, code: "ai_llm_network", message: error instanceof Error ? error.message : "未知错误" };
}

function cardFor(work: WorkRow, tags: string[]) {
  const coverUrl = `/api/works/${work.id}/cover`;
  return {
    id: work.id,
    title: work.title,
    kind: work.kind,
    pageCount: work.page_count,
    rating: work.rating,
    gid: work.gid,
    tags,
    coverUrl,
    thumbUrl: coverUrl,
    imageUrl: coverUrl,
  };
}

function tagsOf(db: Db, workId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.namespace, t.name FROM tags t
         JOIN work_tags wt ON wt.tag_id = t.id
        WHERE wt.work_id = ?
        ORDER BY t.namespace, t.name`,
    )
    .all(workId) as Array<{ namespace: string; name: string }>;
  return rows.map((row) => `${row.namespace}:${row.name}`);
}

export function registerAiRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  app.get("/api/ai", async (): Promise<AiStateResponse> => ({ ai: stateOf(config, db) }));

  app.put("/api/ai", async (request, reply) => {
    const body = request.body as
      | {
          enabled?: unknown;
          model?: unknown;
          baseUrl?: unknown;
          apiKey?: unknown;
          explain?: unknown;
          summarize?: unknown;
          classify?: unknown;
        }
      | undefined;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: { code: "bad_request", message: "请求体必须是 JSON 对象" } });
    }
    if (typeof body.enabled === "boolean") setSetting(db, SETTING_ENABLED, body.enabled ? "1" : "0");
    if (typeof body.explain === "boolean") setSetting(db, SETTING_EXPLAIN, body.explain ? "1" : "0");
    if (typeof body.summarize === "boolean") setSetting(db, SETTING_SUMMARY, body.summarize ? "1" : "0");
    if (typeof body.classify === "boolean") setSetting(db, CLASSIFY_SETTING, body.classify ? "1" : "0");
    if (typeof body.model === "string" && body.model.trim()) {
      setSetting(db, SETTING_MODEL, body.model.trim().slice(0, 120));
    }
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      const url = body.baseUrl.trim().slice(0, 300);
      if (!/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: { code: "invalid_base_url", message: "baseUrl 需要以 http(s):// 开头" } });
      }
      setSetting(db, SETTING_BASE_URL, url.replace(/\/+$/, ""));
    }
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      const key = body.apiKey.trim();
      if (key.length < 8) {
        return reply.code(400).send({ error: { code: "invalid_api_key", message: "API Key 太短" } });
      }
      upsertSourceCredential(db, SOURCE, encryptJson(loadMasterKey(config.configDir), { apiKey: key }));
      setSetting(db, SETTING_ENABLED, "1");
    }
    const next = stateOf(config, db);
    if (next.enabled && !next.configured) {
      setSetting(db, SETTING_ENABLED, "0");
      return reply.code(400).send({
        error: { code: "ai_no_key", message: "请先填写 DeepSeek API Key，再打开「开启 AI 搜索」开关" },
      });
    }
    return { ai: next };
  });

  app.delete("/api/ai/key", async (): Promise<AiStateResponse> => {
    deleteSourceCredential(db, SOURCE);
    setSetting(db, SETTING_ENABLED, "0");
    return { ai: stateOf(config, db) };
  });

  app.post("/api/ai/health", async (_request, reply) => {
    const gate = gateOf(config, db);
    if (gate) return reply.code(gate.status).send({ error: { code: gate.code, message: gate.message } });
    try {
      const client = makeClient(config, db);
      const health: AdapterHealth = await client.healthCheck();
      return { health };
    } catch (error) {
      const http = llmErrorToHttp(error);
      return reply.code(http.status).send({ error: { code: http.code, message: http.message } });
    }
  });

  app.post("/api/ai/query", async (request, reply) => {
    const body = request.body as { q?: unknown } | undefined;
    const question = typeof body?.q === "string" ? body.q.trim() : "";
    if (!question) {
      return reply.code(400).send({ error: { code: "empty_query", message: "请描述你想找什么" } });
    }
    if (question.length > 500) {
      return reply.code(400).send({ error: { code: "query_too_long", message: "描述请控制在 500 字以内" } });
    }

    const state = stateOf(config, db);
    const gate = gateOf(config, db);
    if (gate) return reply.code(gate.status).send({ error: { code: gate.code, message: gate.message } });

    const libraries = listLibraries(db).map((library) => ({
      id: library.id,
      name: library.name,
      kind: library.kind,
      workCount: countWorksInLibrary(db, library.id),
    }));
    const tags = listTags(db, undefined, 60).map((tag) => ({
      label: tag.name.includes(":") ? tag.name : `${tag.namespace}:${tag.name}`,
      count: tag.count,
    }));

    let plan: NlSearchPlan;
    let raw: string;
    try {
      const client = makeClient(config, db);
      raw = await client.complete(
        buildNlSearchMessages(question, {
          libraries,
          tags,
        }),
      );
      bumpUsage(db);
    } catch (error) {
      const http = llmErrorToHttp(error);
      return reply.code(http.status).send({ error: { code: http.code, message: http.message } });
    }

    try {
      plan = parseNlSearchPlan(raw);
    } catch (error) {
      return reply.code(422).send({
        error: {
          code: "ai_bad_response",
          message: error instanceof Error ? error.message : "模型返回无法解析",
        },
      });
    }

    const rawQuery = sanitizeQueryText(plan.query);
    const query = rawQuery;
    const sort = planSort(plan);
    const result = listWorks(db, { q: query, sort, page: 1, pageSize: 60 });

    const items = result.items.map((work) => cardFor(work, tagsOf(db, work.id)));
    const tagCounts = new Map<string, number>();
    for (const item of items) {
      for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const facets = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));

    return {
      query,
      explanation: state.explain ? (plan.explanation ?? null) : null,
      sort,
      total: result.total,
      items,
      facets,
      effective: queryHasFilters(query),
    };
  });
}

/**
 * 标题翻译：把作品标题翻译成简体中文并写入 works.title_zh。
 * 只做单条按需翻译（与 AI 搜索共用门禁/密钥/模型），不自动批量翻译。
 */
export function registerTranslateRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): void {
  app.post("/api/works/:id/translate-title", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const gate = gateOf(config, db);
    if (gate) return reply.code(gate.status).send({ error: { code: gate.code, message: gate.message } });

    let client: LlmClient;
    try {
      client = makeClient(config, db);
    } catch (error) {
      const mapped = llmErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }

    const messages = [
      {
        role: "system" as const,
        content:
          "你是翻译助手，把漫画/图集的标题翻译成简体中文。只输出译文本身，不要引号、解释、原文或任何前后缀。",
      },
      { role: "user" as const, content: work.title },
    ];
    try {
      const raw = await client.complete(messages);
      const titleZh = raw
        .replace(/^["'「『]|["'」』]$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      if (!titleZh) {
        return reply
          .code(502)
          .send({ error: { code: "ai_bad_response", message: "模型未返回有效译文" } });
      }
      setTitleZh(db, work.id, titleZh);
      bumpUsage(db);
      addAuditLog(db, { action: "work.translate_title", target: String(work.id) });
      return { id: work.id, title: work.title, titleZh };
    } catch (error) {
      const mapped = llmErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
  });
}

const CLASSIFY_SETTING = "ai.classify_enabled";

interface ClassifyResult {
  kind: "comic" | "image-set" | "video";
  confidence: number;
  reason?: string;
}

function parseClassification(raw: string): ClassifyResult {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) throw new LlmError("bad_response", "模型未返回 JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    throw new LlmError("bad_response", "模型返回的 JSON 无法解析");
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "comic" && kind !== "image-set" && kind !== "video") {
    throw new LlmError("bad_response", "模型返回的分类不在允许范围");
  }
  const confidence = Number(record.confidence);
  return {
    kind,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6,
    reason: typeof record.reason === "string" ? record.reason.slice(0, 200) : undefined,
  };
}

/**
 * AI 分类：对「启发式判不准」的特殊目录，用 LLM 判定作品类型。
 * - 默认关闭（设置项 ai.classify_enabled），且同样受 ENABLE_LLM_SEARCH 硬开关约束；
 * - 只改索引里的 kind，不动磁盘；每次结果写入审计日志，可人工改回；
 * - 结果缓存在 scrape_cache（30 天），避免重复计费。
 */
export function registerClassifyRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): void {
  app.post("/api/works/:id/classify", async (request, reply) => {
    const work = findWork(db, Number((request.params as { id: string }).id));
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const gate = gateOf(config, db);
    if (gate) return reply.code(gate.status).send({ error: { code: gate.code, message: gate.message } });
    if (!getSettingBoolean(db, CLASSIFY_SETTING, false)) {
      return reply.code(409).send({
        error: {
          code: "ai_classify_disabled",
          message: "AI 分类未开启：请在设置页打开「允许 AI 判断类型」开关",
        },
      });
    }

    const cacheKey = `ai:classify:${work.id}:${work.kind}:${work.title}`;
    const cached = readScrapeCacheFromDb(db, cacheKey);
    if (cached) return { id: work.id, kind: work.kind, cached: true, result: cached };

    let client: LlmClient;
    try {
      client = makeClient(config, db);
    } catch (error) {
      const mapped = llmErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }

    const messages = [
      {
        role: "system" as const,
        content:
          "你是媒体库分类助手。根据作品标题、路径与页面信息，判断它属于哪一类：" +
          "comic（漫画/同人志/单行本，通常有 ComicInfo 或页数声明 P）、" +
          "image-set（图集/写真/套图，通常有 NO.xx、人名、日期分组）、" +
          "video（视频作品，通常有番号如 ABP-936）。" +
          '只输出 JSON：{"kind":"comic|image-set|video","confidence":0-1,"reason":"简短理由"}。',
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          title: work.title,
          path: work.path,
          kind: work.kind,
          pageCount: work.page_count,
          hasComicInfo: work.has_comicinfo === 1,
          sourceKind: work.source_kind,
        }),
      },
    ];
    try {
      const raw = await client.complete(messages);
      const result = parseClassification(raw);
      updateWorkKind(db, work.id, result.kind);
      writeScrapeCacheToDb(db, cacheKey, result, 30);
      bumpUsage(db);
      addAuditLog(db, {
        action: "work.ai_classify",
        target: String(work.id),
        detail: { from: work.kind, to: result.kind, confidence: result.confidence },
      });
      return { id: work.id, kind: result.kind, previousKind: work.kind, cached: false, result };
    } catch (error) {
      const mapped = llmErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
  });
}

function readScrapeCacheFromDb(db: Db, key: string): unknown | null {
  const row = db
    .prepare("SELECT payload, expires_at FROM scrape_cache WHERE key = ?")
    .get(key) as { payload: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
}

function writeScrapeCacheToDb(db: Db, key: string, payload: unknown, ttlDays: number): void {
  const expires = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO scrape_cache (key, payload, expires_at, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
  ).run(key, JSON.stringify(payload), expires, new Date().toISOString());
}
