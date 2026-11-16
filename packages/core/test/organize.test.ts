import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENAME_PATTERN,
  buildNfo,
  buildRenameTarget,
  nfoFileName,
  planMerge,
  renderTemplate,
  sanitizeSegment,
} from "../src/index.js";

describe("sanitizeSegment", () => {
  it("替换非法字符并折叠空白", () => {
    expect(sanitizeSegment('A/B:C*D?"E"<F>|G')).toBe("A B C D E F G");
  });

  it("去掉尾随点与空格、规避 Windows 保留名", () => {
    expect(sanitizeSegment("标题... ")).toBe("标题");
    expect(sanitizeSegment("CON")).toBe("_CON");
  });

  it("空输入回退 untitled，超长截断", () => {
    expect(sanitizeSegment("   ")).toBe("untitled");
    expect(sanitizeSegment("x".repeat(200), 20)).toHaveLength(20);
  });
});

describe("renderTemplate", () => {
  it("渲染默认模板", () => {
    const out = renderTemplate(DEFAULT_RENAME_PATTERN, { author: "作者", title: "标题", pages: 42 });
    expect(out).toBe("作者 - 标题 [42P]");
  });

  it("缺失变量为空且不产生多余空格段", () => {
    expect(renderTemplate("{author}/{title}", { title: "T" })).toBe("T");
  });

  it("支持多级目录模板", () => {
    const out = renderTemplate("{series}/{title} [{pages}P]", { series: "系列", title: "T", pages: 3 });
    expect(out).toBe("系列/T [3P]");
  });
});

describe("buildRenameTarget", () => {
  it("生成 root 下的目标路径", () => {
    const plan = buildRenameTarget("/data/lib/旧", "/data/lib", "{title}", { title: "新" });
    expect(plan.to).toBe("/data/lib/新");
    expect(plan.conflict).toBeNull();
  });

  it("拒绝越出媒体库根", () => {
    const plan = buildRenameTarget("/data/lib/旧", "/data/lib", "../{title}", { title: "x" });
    expect(plan.conflict).toBe("invalid_path");
  });
});

describe("buildNfo", () => {
  it("生成 movie NFO 并转义 XML", () => {
    const nfo = buildNfo({
      id: 1,
      title: "Tom & Jerry <Special>",
      kind: "comic",
      pageCount: 42,
      gid: 1234567,
      tags: ["group:汉化组", "language:中文"],
      author: "作者",
    });
    expect(nfo.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(nfo).toContain("<title>Tom &amp; Jerry &lt;Special&gt;</title>");
    expect(nfo).toContain("<uniqueid type=\"eh\" default=\"true\">1234567</uniqueid>");
    expect(nfo).toContain("<genre>group:汉化组</genre>");
    expect(nfo).toContain("<pagecount>42</pagecount>");
  });

  it("tvshow 根标签", () => {
    const nfo = buildNfo({ id: 2, title: "T", kind: "comic", pageCount: 1 }, { root: "tvshow" });
    expect(nfo).toContain("<tvshow>");
    expect(nfo).not.toContain("<movie>");
  });

  it("文件名清洗", () => {
    expect(nfoFileName({ title: "A/B:C" })).toBe("A B C.nfo");
  });
});

describe("planMerge", () => {
  it("并集标签并给出页码不一致警告", () => {
    const plan = planMerge(
      [
        { id: 1, title: "A", path: "/a", pageCount: 10, tags: ["x", "y"] },
        { id: 2, title: "A (1)", path: "/b", pageCount: 12, tags: ["y", "z"] },
      ],
      1,
    );
    expect(plan.keepId).toBe(1);
    expect(plan.dropIds).toEqual([2]);
    expect(plan.mergedTags).toEqual(["x", "y", "z"]);
    expect(plan.totalPages).toBe(10);
    expect(plan.warnings[0]).toContain("页数不一致");
  });

  it("保留项不存在时抛错", () => {
    expect(() => planMerge([{ id: 1, title: "A", path: "/a", pageCount: 1 }], 9)).toThrow(
      "keep_work_not_found",
    );
  });
});
