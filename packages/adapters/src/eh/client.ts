/**
 * E-H 里站客户端：串行 + 限速 + 登录失效/CF/509 分类错误。
 * 网络通过注入的 fetch 调用，单测与 CI 不产生真实流量。
 */
import type { AdapterHealth, ScrapeCandidate, ScraperAdapter } from "../index.js";
import {
  looksLikeCfChallenge,
  looksLikeLoginPage,
  parseGalleryHtml,
  parseGdataResponse,
  parseSearchForToken,
  type EhMetadata,
} from "./parse.js";

export const EXHENTAI_BASE = "https://exhentai.org";
export const EXHENTAI_API = "https://s.exhentai.org/api.php";

export interface EhCookie {
  ipbMemberId: string;
  ipbPassHash: string;
  igneous: string;
  /** 可选：EhViewer 配发的 `star` Cookie（部分账号启用）；缺省则不发送。 */
  star?: string;
  cfClearance?: string;
  userAgent?: string;
}

export type EhErrorCode =
  | "login_required"
  | "cf_challenge"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "ip_banned"
  | "network"
  | "parse"
  | "disabled";

export class EhError extends Error {
  readonly code: EhErrorCode;
  readonly status: number | null;
  /** 冷却建议（毫秒）：509 配额超限时给调用方做退避，0 表示不适用。 */
  readonly retryAfterMs: number;

  constructor(
    code: EhErrorCode,
    message: string,
    status: number | null = null,
    retryAfterMs = 0,
  ) {
    super(message);
    this.name = "EhError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface EhClientOptions {
  cookie: EhCookie;
  fetchImpl?: typeof fetch;
  /** 两次请求之间的最小间隔；EhViewer 常量为 5000ms。 */
  minIntervalMs?: number;
  maxRetries?: number;
  baseUrl?: string;
  apiUrl?: string;
  /** 注入时钟与睡眠，便于测试限速。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EhCandidate extends ScrapeCandidate {
  gid: number;
  token: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function cookieHeader(cookie: EhCookie): string {
  const parts = [
    `ipb_member_id=${cookie.ipbMemberId}`,
    `ipb_pass_hash=${cookie.ipbPassHash}`,
    `igneous=${cookie.igneous}`,
  ];
  if (cookie.star) parts.push(`star=${cookie.star}`);
  if (cookie.cfClearance) parts.push(`cf_clearance=${cookie.cfClearance}`);
  return parts.join("; ");
}

export class EhClient {
  private readonly options: Required<
    Pick<EhClientOptions, "minIntervalMs" | "maxRetries" | "baseUrl" | "apiUrl">
  > & {
    fetchImpl: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    cookie: EhCookie;
  };

  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: EhClientOptions) {
    this.options = {
      cookie: options.cookie,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      minIntervalMs: options.minIntervalMs ?? 5000,
      maxRetries: options.maxRetries ?? 1,
      baseUrl: options.baseUrl ?? EXHENTAI_BASE,
      apiUrl: options.apiUrl ?? EXHENTAI_API,
      now: options.now ?? (() => Date.now()),
      sleep:
        options.sleep ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /** 串行化 + 最小间隔，任何时刻只有一个请求在飞。 */
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastRequestAt + this.options.minIntervalMs - this.options.now();
      if (wait > 0) await this.options.sleep(wait);
      try {
        return await task();
      } finally {
        this.lastRequestAt = this.options.now();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private headers(): Record<string, string> {
    return {
      cookie: cookieHeader(this.options.cookie),
      "user-agent": this.options.cookie.userAgent ?? DEFAULT_USER_AGENT,
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
    };
  }

  private async attempt(url: string, init: RequestInit): Promise<Response> {
    const response = await this.options.fetchImpl(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      redirect: "follow",
    });
    if (response.status === 509) {
      // 509：里站图片配额超限，需要冷却（EhViewer 的做法是退避后换 IP/稍后再来）
      throw new EhError("quota_exceeded", "E-H 配额超限（509），请冷却后再试", 509, 60 * 60 * 1000);
    }
    return response;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.schedule(() => this.attempt(url, init));
      } catch (error) {
        lastError = error;
        if (
          error instanceof EhError &&
          (error.code === "rate_limited" ||
            error.code === "quota_exceeded" ||
            error.code === "ip_banned" ||
            error.code === "cf_challenge")
        ) {
          break;
        }
      }
    }
    throw lastError instanceof EhError
      ? lastError
      : new EhError("network", lastError instanceof Error ? lastError.message : "网络请求失败");
  }

  private async readHtml(response: Response): Promise<string> {
    const html = await response.text();
    // E-H 的封禁/未登录占位图（sadpanda / kokomoe）会出现在 HTML 或图片 302 上
    if (/img\/(sadpanda|kokomoe)\.(gif|jpg|png)/i.test(html)) {
      throw new EhError(
        "ip_banned",
        "里站返回 sadpanda/kokomoe：账号或出口 IP 被封禁/未登录",
        403,
        24 * 60 * 60 * 1000,
      );
    }
    if (looksLikeCfChallenge(html, response.headers.get("cf-mitigated"))) {
      throw new EhError("cf_challenge", "里站被 Cloudflare 挑战拦截，请更新 cf_clearance", 403);
    }
    if (response.status >= 400 && response.status !== 404) {
      throw new EhError("network", `E-H 返回 HTTP ${response.status}`, response.status);
    }
    return html;
  }

  /** gdata：gid 与 token 必须成对，单次 ≤25 组。 */
  async fetchGdata(entries: ReadonlyArray<[number, string]>): Promise<EhMetadata[]> {
    if (entries.length === 0) return [];
    if (entries.length > 25) throw new EhError("parse", "gdata 单次最多 25 组 gid/token");
    const response = await this.request(this.options.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "gdata",
        gidlist: entries.map(([gid, token]) => [gid, token]),
        namespace: 1,
      }),
    });
    if (!response.ok) {
      throw new EhError("network", `E-H API HTTP ${response.status}`, response.status);
    }
    const payload: unknown = await response.json();
    const metas = parseGdataResponse(payload, entries.map(([gid]) => gid));
    const failed = (payload as { gmetadata?: Array<{ error?: string }> }).gmetadata?.find(
      (item) => typeof item.error === "string",
    );
    if (metas.length === 0 && failed?.error) {
      throw new EhError("not_found", `E-H 未找到该画廊：${failed.error}`);
    }
    return metas;
  }

  /** 命中链路②③：站内搜索 `f_search=gid:{gid}` 找 token。 */
  async resolveToken(gid: number): Promise<string | null> {
    const url = `${this.options.baseUrl}/?f_search=${encodeURIComponent(`gid:${gid}`)}`;
    const response = await this.request(url);
    const html = await this.readHtml(response);
    if (looksLikeLoginPage(html, response.url)) {
      throw new EhError("login_required", "里站登录状态无效，请重新导入 Cookie", 401);
    }
    return parseSearchForToken(html, gid);
  }

  /** 抓取详情页并解析。 */
  async detail(gid: number, token: string): Promise<EhMetadata> {
    const url = `${this.options.baseUrl}/g/${gid}/${token}/`;
    const response = await this.request(url);
    if (response.status === 404) throw new EhError("not_found", "画廊不存在或 token 失效", 404);
    const html = await this.readHtml(response);
    if (looksLikeLoginPage(html, response.url)) {
      throw new EhError("login_required", "里站登录状态无效，请重新导入 Cookie", 401);
    }
    const meta = parseGalleryHtml(html, gid, token);
    if (!meta || !meta.title) {
      throw new EhError("parse", "无法解析画廊详情页（页面结构可能变化）");
    }
    return meta;
  }

  /** 连通性/登录健康检查：请求首页，登录页即视为失效。 */
  async healthCheck(): Promise<AdapterHealth> {
    const started = this.options.now();
    try {
      const response = await this.request(`${this.options.baseUrl}/`);
      const html = await this.readHtml(response);
      if (looksLikeLoginPage(html, response.url)) {
        return { ok: false, latencyMs: this.options.now() - started, error: "里站登录状态无效" };
      }
      return { ok: true, latencyMs: this.options.now() - started, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: this.options.now() - started,
        error: error instanceof Error ? error.message : "健康检查失败",
      };
    }
  }
}

/** 包成统一的 ScraperAdapter，供 server 以 `adapter.getDetail()` 调用。 */
export function createEhAdapter(client: EhClient): ScraperAdapter<EhCandidate> {
  return {
    id: "e-hentai",
    kind: "eh",
    async searchByCode(code: string): Promise<EhCandidate[]> {
      const gid = Number(code);
      if (!Number.isFinite(gid) || gid <= 0) return [];
      const token = await client.resolveToken(gid);
      if (!token) return [];
      return [
        {
          source: "e-hentai",
          externalId: String(gid),
          title: `gid:${gid}`,
          url: `${EXHENTAI_BASE}/g/${gid}/${token}/`,
          gid,
          token,
        },
      ];
    },
    async getDetail(candidate: EhCandidate): Promise<EhMetadata> {
      return client.detail(candidate.gid, candidate.token);
    },
    async getAssets(): Promise<{ thumbs: Uint8Array[] }> {
      // 封面/缩略图走图片 CDN，后续版本接入；当前只同步元数据
      return { thumbs: [] };
    },
    healthCheck: () => client.healthCheck(),
  };
}
