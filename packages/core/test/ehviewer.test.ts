/**
 * `.ehviewer` 私有记录解析。
 * 格式依据 EhViewer SpiderInfo.java：VERSION2 起为文本行式，不是 CBOR。
 */
import { describe, expect, it } from "vitest";
import { parseEhViewerText } from "@nekoshelf/core";

const SAMPLE = [
  "VERSION2",
  "00000003 startPage",
  "1114159",
  "0c3a1e4d5f6b7a89",
  "8",
  "42",
  "0 6f4a11aa22bb33cc",
  "1 7a5b22bb33cc44dd",
].join("\n");

describe("parseEhViewerText", () => {
  it("解析 VERSION2 文本格式的进度、gid、token 与页数", () => {
    const info = parseEhViewerText(SAMPLE);
    expect(info).not.toBeNull();
    expect(info?.version).toBe(2);
    expect(info?.startPage).toBe(3);
    expect(info?.gid).toBe(1114159);
    expect(info?.token).toBe("0c3a1e4d5f6b7a89");
    expect(info?.previewPages).toBe(8);
    expect(info?.pages).toBe(42);
    expect(info?.pTokens.get(1)).toBe("7a5b22bb33cc44dd");
  });

  it("二进制旧格式与任意文本返回 null", () => {
    expect(parseEhViewerText("\u0000VERSION2\u0000\u0001")).toBeNull();
    expect(parseEhViewerText("random notes")).toBeNull();
    expect(parseEhViewerText("")).toBeNull();
  });

  it("缺 token 时仍给出 gid（交给站内搜索兜底）", () => {
    const info = parseEhViewerText(["VERSION2", "00000000 startPage", "999", "", "2", "3"].join("\n"));
    expect(info?.gid).toBe(999);
    expect(info?.token).toBeNull();
  });
});
