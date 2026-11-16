import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 当前对外 API 主版本（与 `X-API-Version` 请求头、`/api/meta.apiVersion` 一致，见 。 */
export const API_VERSION = "1";

/** 由「路径前缀」派生；独立客户端据此拼 URL。 */
export const API_PREFIX = "/api";

export interface AppConfig {
  httpPort: number;
  host: string;
  /** `/config`：数据库与凭据，必须本地卷。 */
  configDir: string;
  /** `/cache`：缩略图、解压缓存，可清空。 */
  cacheDir: string;
  dataMode: "readonly" | "writeback";
  /** 会话有效期，默认 30 天。 */
  sessionTtlMs: number;
  /** 是否启用外网刮削。 */
  enableScraper: boolean;
  /** 允许跨域的客户端 Origin 列表（`CORS_ORIGINS`，逗号分隔；空数组 = 不启用 CORS）。 */
  corsOrigins: string[];
  /** 自然语言搜索的硬门禁与环境默认值（`ENABLE_LLM_SEARCH` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`）。 */
  llm: {
    envEnabled: boolean;
    baseUrl: string;
    defaultModel: string;
    envApiKey: string;
    timeoutMs: number;
  };
  version: string;
  /** 启动时自动扫描所有库（`SCAN_ON_START=true`，容器化无头部署用）。 */
  scanOnStart: boolean;
  /** 启动时注入的管理员 Token 明文（`BOOTSTRAP_API_TOKEN`，首次启动写库一次）。 */
  bootstrapApiToken: string;
  /** 未匹配番号视频的策略（`UNMATCHED_VIDEO_POLICY`）：skip=跳过（默认）、as-work=作为普通视频入库。 */
  unmatchedVideoPolicy: "skip" | "as-work";
  /** 网络卷扫描节流毫秒（`SCAN_DELAY_MS`），SMB/NFS 场景建议 ≥1。 */
  scanDelayMs: number;
}

/** 从服务端 package.json 读版本号（构建前后路径都指向 apps/server/package.json）。 */
function packageVersion(): string {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** `CORS_ORIGINS="http://localhost:5173, capacitor://localhost"` → 精确匹配的 Origin 列表。 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = raw
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set(origins)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = resolve(env.CONFIG_DIR ?? "./data/config");
  return {
    httpPort: Number(env.HTTP_PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    configDir,
    cacheDir: resolve(env.CACHE_DIR ?? "./data/cache"),
    dataMode: env.DATA_MODE === "writeback" ? "writeback" : "readonly",
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    enableScraper: env.ENABLE_SCRAPER === "true",
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    llm: {
      envEnabled: env.ENABLE_LLM_SEARCH === "true",
      baseUrl: env.LLM_BASE_URL?.trim() || "https://api.deepseek.com",
      defaultModel: env.LLM_MODEL?.trim() || "deepseek-chat",
      envApiKey: env.LLM_API_KEY?.trim() || "",
      timeoutMs: Math.max(5_000, Number(env.LLM_TIMEOUT_MS ?? 20_000)),
    },
    version: env.APP_VERSION ?? packageVersion(),
    scanOnStart: env.SCAN_ON_START === "true",
    bootstrapApiToken: env.BOOTSTRAP_API_TOKEN?.trim() ?? "",
    unmatchedVideoPolicy: env.UNMATCHED_VIDEO_POLICY === "as-work" ? "as-work" : "skip",
    scanDelayMs: Math.max(0, Number(env.SCAN_DELAY_MS ?? 0) || 0),
  };
}

export function dbPath(config: AppConfig): string {
  return resolve(config.configDir, "nekoshelf.db");
}
