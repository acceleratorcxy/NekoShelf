/**
 * 搜索查询语法（参考 LANraragi Search.pm 的简化实现）。
 * 覆盖：解析、SQL 编译、与真实 SQLite（含 FTS/标签/进度）的联查行为。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLibrary,
  listWorks,
  needsProgressJoin,
  openDatabase,
  parseSearchQuery,
  searchFiltersToSql,
  setProgress,
  setWorkTags,
  upsertWork,
  type Db,
} from "@nekoshelf/core";

let db: Db;
let libraryId: number;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  libraryId = createLibrary(db, { name: "本子", rootPath: "C:\\samples\\本子", kind: "comic" }).id;
});

afterEach(() => {
  db.close();
});

function addWork(
  title: string,
  options: { pageCount?: number; progress?: number; tags?: Array<[string, string]> } = {},
): number {
  const id = upsertWork(db, {
    libraryId,
    relativePath: `${title}\\`,
    title,
    kind: "comic",
    sourceKind: "directory",
    gid: null,
    pageCount: options.pageCount ?? 20,
    mtime: 1,
    sizeBytes: 1,
    fingerprint: null,
  }).id;
  if (options.tags) setWorkTags(db, id, options.tags.map(([namespace, name]) => ({ namespace, name })));
  if (options.progress !== undefined) {
    setProgress(db, id, options.progress, options.pageCount ?? 20);
  }
  return id;
}

describe("parseSearchQuery", () => {
  it("把空白与逗号都当作 AND 分隔符", () => {
    const filters = parseSearchQuery("猫,女仆 咖啡");
    expect(filters.terms).toEqual(["猫", "女仆", "咖啡"]);
  });

  it("解析排除、精确、通配、标签、页数与进度", () => {
    const filters = parseSearchQuery("-ntr $Exact? tag:language:chinese tag:big breasts pages:>20 read:<=30");
    expect(filters.excludes).toEqual(["ntr"]);
    expect(filters.exact).toEqual(["Exact?"]);
    expect(filters.tags).toEqual([
      { namespace: "language", name: "chinese", exclude: false },
      { namespace: undefined, name: "big", exclude: false },
    ]);
    // 标签名含空格时只吃第一个词，其余仍按普通关键词处理
    expect(filters.terms).toEqual(["breasts"]);
    expect(filters.pageMin).toBe(21);
    expect(filters.readMax).toBe(30);
  });

  it("支持区间与复合边界", () => {
    const filters = parseSearchQuery("pages:20-40 read:0-10");
    expect(filters.pageMin).toBe(20);
    expect(filters.pageMax).toBe(40);
    expect(filters.readMin).toBe(0);
    expect(filters.readMax).toBe(10);
  });

  it("通配符 ? 转成单字符、* / % 转任意长度", () => {
    const filters = parseSearchQuery("猫* ?娘");
    expect(filters.wildcards).toEqual(["猫*", "?娘"]);
  });

  it("进度条件会要求 JOIN progress", () => {
    expect(needsProgressJoin(parseSearchQuery("read:>10"))).toBe(true);
    expect(needsProgressJoin(parseSearchQuery("猫"))).toBe(false);
  });

  it("LIKE 转义：用户输入的 % _ \\ 不会变成通配", () => {
    const fragment = searchFiltersToSql(parseSearchQuery("$100%\\_"));
    expect(fragment.params[0]).toBe("100%\\_");
    expect(fragment.where[0]).toContain("= ? COLLATE NOCASE");
  });
});

describe("listWorks 结合查询语法", () => {
  it("关键词走 FTS，排除项不命中", () => {
    addWork("猫与女仆");
    addWork("猫与女仆 NTR");
    addWork("咖啡屋");
    expect(listWorks(db, { q: "猫", pageSize: 50 }).total).toBe(2);
    expect(listWorks(db, { q: "猫 -NTR", pageSize: 50 }).total).toBe(1);
  });

  it("按标签名与 namespace 过滤", () => {
    addWork("A", { tags: [["language", "chinese"], ["artist", "abc"]] });
    addWork("B", { tags: [["language", "english"]] });
    expect(listWorks(db, { q: "tag:language:chinese", pageSize: 50 }).total).toBe(1);
    expect(listWorks(db, { q: "tag:language:english", pageSize: 50 }).total).toBe(1);
    expect(listWorks(db, { q: "tag:https", pageSize: 50 }).total).toBe(0);
  });

  it("页数过滤与进度过滤", () => {
    addWork("短篇", { pageCount: 12 });
    addWork("长篇", { pageCount: 88, progress: 80 });
    expect(listWorks(db, { q: "pages:>50", pageSize: 50 }).total).toBe(1);
    expect(listWorks(db, { q: "read:>=90", pageSize: 50 }).total).toBe(1);
    expect(listWorks(db, { q: "read:<5", pageSize: 50 }).total).toBe(1);
  });

  it("精确标题与通配标题", () => {
    addWork("Alpha");
    addWork("Alpha 2");
    addWork("Beta");
    expect(listWorks(db, { q: "$Alpha", pageSize: 50 }).total).toBe(1);
    expect(listWorks(db, { q: "Alpha*", pageSize: 50 }).total).toBe(2);
    expect(listWorks(db, { q: "?lpha", pageSize: 50 }).total).toBe(1);
  });
});
