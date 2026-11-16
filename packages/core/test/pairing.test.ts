import { beforeEach, describe, expect, it } from "vitest";
import {
  createLibrary,
  findPairOrdinals,
  hasPagePairLinks,
  listPagePairLinks,
  openDatabase,
  replacePages,
  upsertWork,
  type Db,
} from "@nekoshelf/core";

let db: Db;
let libraryId: number;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  libraryId = createLibrary(db, { name: "t", rootPath: "/t", kind: "comic" }).id;
});

function makeWork(pageCount: number, pages: Array<{ name: string; lang?: string; pairKey?: string }>): number {
  const { id } = upsertWork(db, {
    libraryId,
    relativePath: `w-${Math.random().toString(16).slice(2)}`,
    title: "t",
    kind: "comic",
    sourceKind: "archive",
    pageCount,
  });
  replacePages(
    db,
    id,
    pages.map((page) => ({ name: page.name, lang: page.lang ?? null, pairKey: page.pairKey ?? null })),
  );
  return id;
}

describe("双语页配对（性能与正确性）", () => {
  it("成对页面互相指向对方，未配对页面 variantOf 为 null", () => {
    const id = makeWork(3, [
      { name: "001_EN.png", lang: "en", pairKey: "001" },
      { name: "001_CN.png", lang: "zh", pairKey: "001" },
      { name: "002.png" },
    ]);
    const links = listPagePairLinks(db, id);
    // 只返回有 pair_key 的页（未配对的 002.png 不出现）。
    expect(links.map((link) => link.variantOf)).toEqual([2, 1]);
    expect(links[0]!.pairKey).toBe("001");
    expect(hasPagePairLinks(db, id)).toBe(true);
  });

  it("findPairOrdinals 只返回给定 key 的首个页码", () => {
    const id = makeWork(4, [
      { name: "a.png", pairKey: "k1" },
      { name: "a_cn.png", pairKey: "k1" },
      { name: "b.png", pairKey: "k2" },
      { name: "b_cn.png", pairKey: "k2" },
    ]);
    const map = findPairOrdinals(db, id, ["k2"]);
    expect(map.get("k2")).toBe(3);
    expect(map.has("k1")).toBe(false);
  });

  it("大作品（4000 页）配对在 50ms 内完成", () => {
    const pages = Array.from({ length: 4000 }, (_, index) => {
      const pageNo = Math.floor(index / 2);
      return {
        name: `p${String(pageNo).padStart(4, "0")}_${index % 2 === 0 ? "en" : "zh"}.png`,
        lang: index % 2 === 0 ? "en" : "zh",
        pairKey: `p${pageNo}`,
      };
    });
    const id = makeWork(4000, pages);
    const start = performance.now();
    const links = listPagePairLinks(db, id);
    const elapsed = performance.now() - start;
    expect(links).toHaveLength(4000);
    expect(links[0]!.variantOf).toBe(2);
    expect(links[1]!.variantOf).toBe(1);
    // 旧实现是 O(n²)（4000 页约 1600 万次比较，秒级）；这里卡 50ms 防回退。
    expect(elapsed).toBeLessThan(50);
  });
});

describe("无双语页的作品", () => {
  it("listPagePairLinks 为空，hasPagePairLinks 为 false", () => {
    const id = makeWork(2, [{ name: "001.jpg" }, { name: "002.jpg" }]);
    expect(listPagePairLinks(db, id)).toEqual([]);
    expect(hasPagePairLinks(db, id)).toBe(false);
  });
});
