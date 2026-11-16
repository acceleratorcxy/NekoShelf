/**
 * E-H 刮削：里站 only、默认关闭、已有元数据不重刮、支持手动单条。
 *
 * 决策要点：
 * - 环境变量 ENABLE_SCRAPER=1 且设置页开关打开时，才允许发任何外网请求；
 * - Cookie 加密存 source_credentials（AES-256-GCM），不回显明文；
 * - 单条手动刮削同步返回结果；批量刮削走后台 Job（串行 + 限速）。
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db, WorkRow } from "@nekoshelf/core";
import {
  addAuditLog,
  appendJobLog,
  createJob,
  deleteSourceCredential,
  findSourceCredential,
  findWork,
  getSetting,
  getSettingBoolean,
  listScrapeCandidates,
  listWorkTags,
  parseEhViewerText,
  readScrapeCache,
  setSetting,
  setWorkTags,
  updateJob,
  updateWorkMetadata,
  upsertSourceCredential,
  writeScrapeCache,
} from "@nekoshelf/core";
import {
  EhClient,
  EhError,
  createEhAdapter,
  type EhCandidate,
  type EhCookie,
  type EhMetadata,
} from "@nekoshelf/adapters";
import type { AppConfig } from "../config.js";
import { decryptJson, encryptJson, loadMasterKey } from "../crypto.js";
import { workAbsolutePath } from "../media.js";

const SOURCE = "eh";
const SETTING_ENABLED = "scraper.enabled";
const SETTING_INTERVAL_MS = "scraper.minIntervalMs";
const SETTING_COOLDOWN = "scraper.cooldownUntil";
const DEFAULT_INTERVAL_MS = 5000;
const CACHE_TTL_DAYS = 7;

class ScrapeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ScrapeError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 刮削门禁：只看设置页开关（ENABLE_SCRAPER 已不是硬门禁，仅保留给客户端能力提示）。
 * 默认关闭，不会发出任何外网请求。
 */
function scraperEnabled(db: Db, _config: AppConfig): boolean {
  return getSettingBoolean(db, SETTING_ENABLED, false);
}

/** 509 配额超限后的全局冷却：返回毫秒剩余，0 表示不在冷却期。 */
function cooldownLeftMs(db: Db): number {
  const raw = Number(getSetting(db, SETTING_COOLDOWN) ?? "0");
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw - Date.now());
}

function markCooldown(db: Db, retryAfterMs: number): void {
  if (retryAfterMs > 0) setSetting(db, SETTING_COOLDOWN, String(Date.now() + retryAfterMs));
}

function readCookie(db: Db, config: AppConfig): EhCookie | null {
  const credential = findSourceCredential(db, SOURCE);
  if (!credential) return null;
  return decryptJson<EhCookie>(loadMasterKey(config.configDir), credential.payload);
}

function buildClient(db: Db, config: AppConfig): EhClient | null {
  const cookie = readCookie(db, config);
  if (!cookie) return null;
  const raw = Number(getSetting(db, SETTING_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS);
  const minIntervalMs = Number.isFinite(raw) && raw >= 2000 ? raw : DEFAULT_INTERVAL_MS;
  return new EhClient({ cookie, minIntervalMs });
}

function mapEhError(error: unknown): ScrapeError {
  if (error instanceof EhError) {
    switch (error.code) {
      case "login_required":
        return new ScrapeError("credential_invalid", 409, "里站 Cookie 已失效，请重新导入");
      case "cf_challenge":
        return new ScrapeError("cf_challenge", 502, "里站被 Cloudflare 拦截，请更新 cf_clearance");
      case "rate_limited":
        return new ScrapeError("rate_limited", 429, "里站请求过频，请稍后再试");
      case "quota_exceeded":
        return new ScrapeError("quota_exceeded", 429, error.message);
      case "ip_banned":
        return new ScrapeError("ip_banned", 403, error.message);
      case "not_found":
        return new ScrapeError("not_found", 404, "在里站未找到该画廊");
      default:
        return new ScrapeError("scrape_failed", 502, error.message);
    }
  }
  return new ScrapeError(
    "scrape_failed",
    502,
    error instanceof Error ? error.message : "刮削失败",
  );
}

/**
 * 命中链路①：目录作品的 `.ehviewer` 里直接有 gid+token，
 * 可跳过站内搜索。二进制旧格式或不可读时返回 null，由链路②③兜底。
 */
async function readLocalEhToken(db: Db, work: WorkRow): Promise<string | null> {
  if (work.source_kind !== "directory") return null;
  try {
    const text = await readFile(join(workAbsolutePath(db, work), ".ehviewer"), "utf8");
    return parseEhViewerText(text)?.token ?? null;
  } catch {
    return null;
  }
}

interface ScrapeSummary {
  workId: number;
  title: string;
  pageCount: number | null;
  tagCount: number;
  sourceUrl: string | null;
  cached: boolean;
}

async function scrapeWork(
  db: Db,
  config: AppConfig,
  work: WorkRow,
  options: { force: boolean },
): Promise<ScrapeSummary> {
  if (!scraperEnabled(db, config)) {
    throw new ScrapeError("scraper_disabled", 409, "刮削未开启（需 ENABLE_SCRAPER=1 且设置页开关打开）");
  }
  if (work.gid === null) {
    throw new ScrapeError("no_gid", 400, "该作品没有 gid，无法在里站定位");
  }
  const cooldownMs = cooldownLeftMs(db);
  if (cooldownMs > 0) {
    throw new ScrapeError(
      "cooldown",
      429,
      `里站配额冷却中，约 ${Math.ceil(cooldownMs / 60000)} 分钟后再试`,
    );
  }
  if (!options.force) {
    const hasMeta = work.has_comicinfo === 1 || listWorkTags(db, work.id).length > 0;
    if (hasMeta) {
      throw new ScrapeError("already_scraped", 409, "已有元数据；如需覆盖请选择「强制重刮」");
    }
  }

  let meta: EhMetadata | null = readScrapeCache<EhMetadata>(db, `eh:detail:${work.gid}`);
  const cached = meta !== null;
  if (!meta) {
    const client = buildClient(db, config);
    if (!client) throw new ScrapeError("no_credential", 409, "尚未导入里站 Cookie");
    try {
      const adapter = createEhAdapter(client);
      // 链路①：本地 `.ehviewer` 直接给 token，免一次站内搜索
      const localToken = await readLocalEhToken(db, work);
      const candidate: EhCandidate | undefined = localToken
        ? {
            source: "e-hentai",
            gid: work.gid,
            token: localToken,
            externalId: String(work.gid),
            title: `gid:${work.gid}`,
            url: `https://exhentai.org/g/${work.gid}/${localToken}/`,
          }
        : (await adapter.searchByCode(String(work.gid)))[0];
      if (!candidate) throw new ScrapeError("not_found", 404, "在里站未找到该画廊");
      meta = (await adapter.getDetail(candidate)) as EhMetadata;
      writeScrapeCache(db, `eh:detail:${work.gid}`, meta, CACHE_TTL_DAYS);
    } catch (error) {
      if (error instanceof EhError && error.retryAfterMs > 0) markCooldown(db, error.retryAfterMs);
      throw mapEhError(error);
    }
  }

  const tags = (meta.tags ?? [])
    .filter((tag) => tag.namespace.length > 0 && tag.name.length > 0)
    .map((tag) => ({ namespace: tag.namespace, name: tag.name }));
  if (tags.length > 0) setWorkTags(db, work.id, tags);
  updateWorkMetadata(db, work.id, {
    title: meta.title ?? work.title,
    pageCount: meta.fileCount ?? undefined,
    hasComicInfo: true,
  });
  addAuditLog(db, {
    action: "scrape.apply",
    target: `work:${work.id}`,
    detail: { gid: work.gid, tags: tags.length, source: meta.url, cached },
  });

  return {
    workId: work.id,
    title: meta.title ?? work.title,
    pageCount: meta.fileCount,
    tagCount: tags.length,
    sourceUrl: meta.url,
    cached,
  };
}

export function registerScraperRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const describe = () => ({
    enabled: scraperEnabled(db, config),
    envGate: config.enableScraper,
    hasCredential: findSourceCredential(db, SOURCE) !== null,
    intervalMs: Number(getSetting(db, SETTING_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS),
    candidateCount: listScrapeCandidates(db, { limit: 200 }).length,
    cooldownMs: cooldownLeftMs(db),
  });

  app.get("/api/scraper", async () => ({ scraper: describe() }));

  app.put("/api/scraper", async (request, reply) => {
    const body = request.body as {
      enabled?: unknown;
      cookie?: unknown;
      minIntervalMs?: unknown;
    } | null;

    if (typeof body?.enabled === "boolean") setSetting(db, SETTING_ENABLED, body.enabled ? "1" : "0");
    if (body?.minIntervalMs !== undefined) {
      const interval = Number(body.minIntervalMs);
      if (!Number.isFinite(interval) || interval < 2000 || interval > 60_000) {
        return reply
          .code(400)
          .send({ error: { code: "validation_failed", message: "minIntervalMs 需在 2000–60000 之间" } });
      }
      setSetting(db, SETTING_INTERVAL_MS, String(Math.round(interval)));
    }

    if (body?.cookie !== undefined) {
      const raw = body.cookie as Partial<Record<keyof EhCookie, unknown>> | null;
      const cookie: EhCookie = {
        ipbMemberId: typeof raw?.ipbMemberId === "string" ? raw.ipbMemberId.trim() : "",
        ipbPassHash: typeof raw?.ipbPassHash === "string" ? raw.ipbPassHash.trim() : "",
        igneous: typeof raw?.igneous === "string" ? raw.igneous.trim() : "",
      };
      if (typeof raw?.cfClearance === "string" && raw.cfClearance.trim()) {
        cookie.cfClearance = raw.cfClearance.trim();
      }
      if (typeof raw?.star === "string" && raw.star.trim()) {
        cookie.star = raw.star.trim();
      }
      if (typeof raw?.userAgent === "string" && raw.userAgent.trim()) {
        cookie.userAgent = raw.userAgent.trim();
      }
      if (!cookie.ipbMemberId || !cookie.ipbPassHash || !cookie.igneous) {
        return reply.code(400).send({
          error: {
            code: "validation_failed",
            message: "ipb_member_id / ipb_pass_hash / igneous 三项必填",
          },
        });
      }
      upsertSourceCredential(db, SOURCE, encryptJson(loadMasterKey(config.configDir), cookie));
      // 换了 Cookie 就解除旧的 509 冷却
      setSetting(db, SETTING_COOLDOWN, "0");
      addAuditLog(db, { action: "scraper.cookie.update", target: `source:${SOURCE}` });
    }

    return { scraper: describe() };
  });

  app.delete("/api/scraper/cookie", async () => {
    deleteSourceCredential(db, SOURCE);
    setSetting(db, SETTING_ENABLED, "0");
    addAuditLog(db, { action: "scraper.cookie.delete", target: `source:${SOURCE}` });
    return { scraper: describe() };
  });

  app.post("/api/scraper/health", async (_request, reply) => {
    const client = buildClient(db, config);
    if (!client) {
      return reply.code(409).send({ error: { code: "no_credential", message: "尚未导入里站 Cookie" } });
    }
    const health = await client.healthCheck();
    return { health };
  });

  app.post("/api/scrape/works/:id", async (request, reply) => {
    const workId = Number((request.params as { id: string }).id);
    const work = findWork(db, workId);
    if (!work) {
      return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    }
    const body = request.body as { force?: unknown } | null;
    try {
      const summary = await scrapeWork(db, config, work, { force: body?.force === true });
      return { ok: true, applied: summary };
    } catch (error) {
      const mapped = error instanceof ScrapeError ? error : mapEhError(error);
      return reply
        .code(mapped.status)
        .send({ error: { code: mapped.code, message: mapped.message } });
    }
  });

  app.post("/api/scrape/batch", async (request, reply) => {
    if (!scraperEnabled(db, config)) {
      return reply
        .code(409)
        .send({ error: { code: "scraper_disabled", message: "刮削未开启（需 ENABLE_SCRAPER=1 且设置页开关打开）" } });
    }
    const body = request.body as { libraryId?: unknown; limit?: unknown; force?: unknown } | null;
    const libraryId = typeof body?.libraryId === "number" ? body.libraryId : undefined;
    const limit = typeof body?.limit === "number" ? Math.min(Math.max(body.limit, 1), 20) : 10;
    const candidates = listScrapeCandidates(db, { libraryId, limit, force: body?.force === true });
    if (candidates.length === 0) return { jobId: null, candidates: 0 };

    const jobId = randomUUID();
    createJob(db, { id: jobId, type: "scrape", libraryId: libraryId ?? null });

    setImmediate(() => {
      void (async () => {
        updateJob(db, jobId, { state: "running", progress: { done: 0, total: candidates.length } });
        let done = 0;
        let failed = 0;
        for (const candidate of candidates) {
          try {
            const summary = await scrapeWork(db, config, candidate, { force: body?.force === true });
            appendJobLog(db, jobId, `已刮削 #${summary.workId} ${summary.title}（${summary.tagCount} 个标签）`);
          } catch (error) {
            failed += 1;
            appendJobLog(
              db,
              jobId,
              `#${candidate.id} 跳过：${error instanceof Error ? error.message : String(error)}`,
              "warn",
            );
          } finally {
            done += 1;
            updateJob(db, jobId, { progress: { done, total: candidates.length } });
          }
        }
        updateJob(db, jobId, {
          state: failed === candidates.length ? "failed" : "done",
          message: `成功 ${done - failed} / ${candidates.length}`,
        });
      })();
    });

    reply.code(202);
    return { jobId, candidates: candidates.length };
  });
}

/** 供 /api/works 详情返回刮削状态用。 */
export function scrapeStateFor(db: Db, config: AppConfig, work: WorkRow): {
  enabled: boolean;
  hasCredential: boolean;
  hasMetadata: boolean;
} {
  return {
    enabled: scraperEnabled(db, config),
    hasCredential: findSourceCredential(db, SOURCE) !== null,
    hasMetadata: work.has_comicinfo === 1 || listWorkTags(db, work.id).length > 0,
  };
}
