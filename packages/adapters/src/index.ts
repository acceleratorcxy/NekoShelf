/**
 * 刮削源适配器。
 * 实现放在后续版本；这里先固化接口，便于 server 以统一方式调用与 mock。
 */

export interface ScrapeCandidate {
  /** 来源站点 id，如 `e-hentai`、`javbus`。 */
  source: string;
  /** 站点内稳定 id（E-H 为 gid，AV 为番号）。 */
  externalId: string;
  title: string;
  /** 站点详情页 URL（用于「命中依据」展示）。 */
  url: string;
  /** 携带原始站点数据，避免二次请求。 */
  raw?: unknown;
}

export type AdapterHealth = {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
};

/** 所有适配器的最小契约。 */
export interface ScraperAdapter<TCandidate extends ScrapeCandidate = ScrapeCandidate> {
  readonly id: string;
  readonly kind: "eh" | "av";
  searchByCode(code: string): Promise<TCandidate[]>;
  getDetail(candidate: TCandidate): Promise<unknown>;
  getAssets(detail: unknown): Promise<{ poster?: Uint8Array; thumbs: Uint8Array[] }>;
  healthCheck(): Promise<AdapterHealth>;
}

/* E-H（里站）实现：解析函数 + 限速客户端 + 统一适配器 */
export * from "./eh/parse.js";
export * from "./eh/client.js";

/* LLM（自然语言搜索）：OpenAI 兼容客户端，默认 DeepSeek */
export * from "./llm/client.js";
