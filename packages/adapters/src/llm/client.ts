/**
 * OpenAI 兼容的 LLM 客户端（默认 DeepSeek）。
 *
 * 只做一件事：把 messages 发到 `<baseUrl>/chat/completions` 并取回文本。
 * 网络通过注入的 fetch 调用，单测/CI 不产生真实流量；默认 20s 超时。
 *
 * 错误语义（server 侧映射成 HTTP）：
 * - auth_failed  密钥无效（401/403）
 * - model_not_found 模型名不存在（404）
 * - rate_limited 限流/余额不足（429/402）
 * - timeout      超时
 * - network      网络不可达/5xx
 * - bad_response 返回结构不符合预期（不是 chat completions 形状）
 */

import type { AdapterHealth } from "../index.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export type LlmErrorCode =
  | "auth_failed"
  | "model_not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "bad_response";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number;

  constructor(code: LlmErrorCode, message: string, status: number | null = null, retryAfterMs = 0) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  apiKey: string;
  /** 默认 `https://api.deepseek.com`（兼容任意 OpenAI 格式网关，如 one-api / Ollama）。 */
  baseUrl?: string;
  /** 默认 `deepseek-chat`；推理模型可用 `deepseek-reasoner`。 */
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  error?: { message?: unknown; type?: unknown };
}

/** 把 HTTP 错误状态映射成带语义的错误码。 */
export function mapHttpStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 402 || status === 429) return "rate_limited";
  return "network";
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new LlmError("bad_response", `LLM_BASE_URL 需要以 http(s):// 开头：${baseUrl}`);
  }
  return trimmed;
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmClientOptions) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) throw new LlmError("auth_failed", "未配置 API Key");
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl?.trim() || DEEPSEEK_BASE_URL);
    this.model = options.model?.trim() || DEEPSEEK_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.temperature = options.temperature ?? 0;
    this.maxTokens = options.maxTokens ?? 400;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new LlmError("network", "当前运行时不支持 fetch");
    this.fetchImpl = fetchImpl;
  }

  get modelName(): string {
    return this.model;
  }

  get baseUrlValue(): string {
    return this.baseUrl;
  }

  /** 调用 chat completions，返回 assistant 文本（已 trim，空字符串视为 bad_response）。 */
  async complete(messages: LlmMessage[], options: CompleteOptions = {}): Promise<string> {
    if (messages.length === 0) throw new LlmError("bad_response", "messages 不能为空");
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens ?? this.maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === "AbortError") {
        throw new LlmError("timeout", `LLM 请求超时（${timeoutMs}ms）`);
      }
      throw new LlmError("network", `LLM 连接失败：${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = (() => {
        try {
          const parsed = JSON.parse(text) as ChatCompletionResponse;
          const message = parsed.error?.message;
          return typeof message === "string" ? message : "";
        } catch {
          return text.slice(0, 200);
        }
      })();
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      throw new LlmError(
        mapHttpStatus(response.status),
        `LLM 返回 ${response.status}${detail ? `：${detail}` : ""}`,
        response.status,
        Number.isFinite(retryAfter) ? Math.max(0, retryAfter) * 1000 : 0,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new LlmError("bad_response", "LLM 返回的不是 JSON");
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LlmError("bad_response", "LLM 返回内容为空");
    }
    return content.trim();
  }

  /** 设置页「测试连接」：发一条最小请求并测延迟。 */
  async healthCheck(): Promise<AdapterHealth> {
    const startedAt = Date.now();
    try {
      await this.complete([{ role: "user", content: "只回复：ok" }], {
        maxTokens: 8,
        timeoutMs: Math.min(this.timeoutMs, 15_000),
      });
      return { ok: true, latencyMs: Date.now() - startedAt, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }
}

/** 默认 DeepSeek 适配器（用户可在设置页换成任意 OpenAI 兼容网关）。 */
export function createDeepSeekClient(options: Omit<LlmClientOptions, "baseUrl" | "model"> & {
  baseUrl?: string;
  model?: string;
}): LlmClient {
  return new LlmClient({
    ...options,
    baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
    model: options.model ?? DEEPSEEK_DEFAULT_MODEL,
  });
}
