import { describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  LlmClient,
  LlmError,
  createDeepSeekClient,
  mapHttpStatus,
} from "../src/llm/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okCompletion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

describe("LlmClient", () => {
  it("默认指向 DeepSeek，并发送 Bearer + 正确 body", async () => {
    const fetchMock = vi.fn(async () => okCompletion('{"query":"猫娘"}'));
    const client = createDeepSeekClient({ apiKey: "sk-test", fetchImpl: fetchMock as unknown as typeof fetch });
    expect(client.baseUrlValue).toBe(DEEPSEEK_BASE_URL);
    expect(client.modelName).toBe(DEEPSEEK_DEFAULT_MODEL);

    const text = await client.complete([{ role: "user", content: "找猫娘" }]);
    expect(text).toBe('{"query":"猫娘"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect((body.messages as unknown[]).length).toBe(1);
  });

  it("支持自定义 baseUrl（末尾斜杠归一）与模型名", async () => {
    const fetchMock = vi.fn(async () => okCompletion("ok"));
    const client = new LlmClient({
      apiKey: "sk",
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "qwen2.5",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.complete([{ role: "user", content: "hi" }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(client.modelName).toBe("qwen2.5");
  });

  it("HTTP 错误映射成语义化错误码", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth_failed"],
      [403, "auth_failed"],
      [404, "model_not_found"],
      [429, "rate_limited"],
      [402, "rate_limited"],
      [500, "network"],
    ];
    for (const [status, code] of cases) {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { message: `bad ${status}` } }, status),
      );
      const client = new LlmClient({ apiKey: "sk", fetchImpl: fetchMock as unknown as typeof fetch });
      await expect(client.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
        name: "LlmError",
        code,
        status,
      });
    }
    expect(mapHttpStatus(401)).toBe("auth_failed");
  });

  it("超时抛 timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = new LlmClient({
      apiKey: "sk",
      timeoutMs: 15,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("空内容 / 非 JSON 视为 bad_response", async () => {
    const empty = new LlmClient({
      apiKey: "sk",
      fetchImpl: (async () => okCompletion("   ")) as unknown as typeof fetch,
    });
    await expect(empty.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "bad_response",
    });

    const broken = new LlmClient({
      apiKey: "sk",
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(broken.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("未配置 key 直接拒绝构造", () => {
    expect(() => new LlmClient({ apiKey: "  " })).toThrow(LlmError);
  });

  it("healthCheck 返回延迟与错误信息", async () => {
    const okFetch = vi.fn(async () => okCompletion("ok"));
    const ok = new LlmClient({ apiKey: "sk", fetchImpl: okFetch as unknown as typeof fetch });
    await expect(ok.healthCheck()).resolves.toMatchObject({ ok: true, error: null });

    const badFetch = vi.fn(async () => jsonResponse({ error: { message: "invalid key" } }, 401));
    const bad = new LlmClient({ apiKey: "sk", fetchImpl: badFetch as unknown as typeof fetch });
    const result = await bad.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid key");
  });
});
