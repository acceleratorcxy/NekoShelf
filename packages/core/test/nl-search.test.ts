import { describe, expect, it } from "vitest";
import {
  buildNlSearchMessages,
  NlPlanError,
  NL_SEARCH_SYSTEM_PROMPT,
  parseNlSearchPlan,
  planSort,
  planToFilters,
  queryHasFilters,
  sanitizeQueryText,
} from "../src/nl-search.js";

describe("buildNlSearchMessages", () => {
  it("把库/标签/标题样例塞进 system 提示词", () => {
    const messages = buildNlSearchMessages("  没看完的猫娘本  ", {
      libraries: [{ name: "漫画库", kind: "comic", workCount: 1200 }],
      tags: [{ label: "language:chinese", count: 900 }],
      sampleTitles: ["[A] 猫娘日记"],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("漫画库(comic, 1200 部)");
    expect(messages[0]!.content).toContain("language:chinese(900)");
    expect(messages[0]!.content).toContain("猫娘日记");
    expect(messages[0]!.content).toContain("只输出 JSON");
    expect(messages[1]).toEqual({ role: "user", content: "没看完的猫娘本" });
  });

  it("没有上下文时给出占位，不出现未替换的 {context}", () => {
    const messages = buildNlSearchMessages("随便");
    expect(messages[0]!.content).not.toContain("{context}");
    expect(messages[0]!.content).toContain("暂无可用上下文");
  });

  it("系统提示词包含完整语法说明", () => {
    for (const fragment of ["tag:", "pages:", "read:", "-关键词", "$完整标题"]) {
      expect(NL_SEARCH_SYSTEM_PROMPT).toContain(fragment);
    }
  });
});

describe("sanitizeQueryText", () => {
  it("去控制字符、压空白并截断", () => {
    expect(sanitizeQueryText("  猫娘\n\t -纯爱  ")).toBe("猫娘 -纯爱");
    expect(sanitizeQueryText(123)).toBe("");
    expect(sanitizeQueryText("x".repeat(500))).toHaveLength(300);
  });
});

describe("queryHasFilters", () => {
  it("区分空查询与有效条件", () => {
    expect(queryHasFilters("")).toBe(false);
    expect(queryHasFilters("   ")).toBe(false);
    expect(queryHasFilters("猫娘")).toBe(true);
    expect(queryHasFilters("tag:language:chinese")).toBe(true);
    expect(queryHasFilters("pages:>10 read:<=50")).toBe(true);
  });
});

describe("parseNlSearchPlan", () => {
  it("解析标准 JSON", () => {
    const plan = parseNlSearchPlan(
      '{"query":"猫娘 -纯爱 tag:language:chinese pages:>20","sort":"title","explanation":"找中文猫娘本，排除纯爱"}',
    );
    expect(plan).toEqual({
      query: "猫娘 -纯爱 tag:language:chinese pages:>20",
      sort: "title",
      explanation: "找中文猫娘本，排除纯爱",
    });
    expect(planToFilters(plan).tags).toHaveLength(1);
    expect(planToFilters(plan).excludes).toEqual(["纯爱"]);
  });

  it("容忍 markdown 代码块与前后解释", () => {
    const raw = '好的，结果如下：\n```json\n{"query":"$猫娘日记"}\n```\n希望有帮助';
    expect(parseNlSearchPlan(raw).query).toBe("$猫娘日记");
  });

  it("忽略未知排序值与过长解释", () => {
    const plan = parseNlSearchPlan(
      `{"query":"猫娘","sort":"random","explanation":"${"很".repeat(200)}"}`,
    );
    expect(plan.sort).toBeUndefined();
    expect(plan.explanation!.length).toBe(80);
    expect(planSort(plan)).toBe("recent");
  });

  it("拒绝非 JSON 与空查询", () => {
    expect(() => parseNlSearchPlan("我不太确定")).toThrow(NlPlanError);
    expect(() => parseNlSearchPlan('{"query":"   "}')).toThrow(/没有给出查询条件/);
    expect(() => parseNlSearchPlan('{"query":123}')).toThrow(NlPlanError);
  });

  it("拒绝无法解析的查询串", () => {
    expect(() => parseNlSearchPlan('{"query":"   "}')).toThrow(/没有给出查询条件/);
    expect(() => parseNlSearchPlan('{"query":"   ,  "}')).toThrow(NlPlanError);
    try {
      parseNlSearchPlan('{"query":"   ,  "}');
    } catch (error) {
      expect((error as NlPlanError).code).toBe("invalid_query");
    }
  });

  it("sort 枚举只接受三种", () => {
    expect(planSort(parseNlSearchPlan('{"query":"a","sort":"rating"}'))).toBe("rating");
  });
});
