/**
 * 刮削相关的数据层：设置、加密凭据占位、缓存、候选筛选、元数据回写。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLibrary,
  deleteSourceCredential,
  findSourceCredential,
  findWork,
  getSetting,
  getSettingBoolean,
  listScrapeCandidates,
  openDatabase,
  readScrapeCache,
  setSetting,
  setWorkTags,
  updateWorkMetadata,
  upsertSourceCredential,
  upsertWork,
  writeScrapeCache,
  type Db,
} from "@nekoshelf/core";

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
});

afterEach(() => {
  db.close();
});

function addWork(
  libraryId: number,
  relativePath: string,
  options: { gid?: number | null; hasComicInfo?: boolean } = {},
): number {
  return upsertWork(db, {
    libraryId,
    relativePath,
    title: relativePath,
    kind: "comic",
    sourceKind: "directory",
    gid: options.gid ?? null,
    pageCount: 10,
    hasComicInfo: options.hasComicInfo ?? false,
  }).id;
}

describe("scraper settings", () => {
  it("默认无值，写入后可按布尔读取", () => {
    expect(getSetting(db, "scraper.enabled")).toBeNull();
    setSetting(db, "scraper.enabled", "1");
    expect(getSettingBoolean(db, "scraper.enabled", false)).toBe(true);
    setSetting(db, "scraper.enabled", "0");
    expect(getSettingBoolean(db, "scraper.enabled", true)).toBe(false);
    expect(getSettingBoolean(db, "missing.key", true)).toBe(true);
  });

  it("同一 key 覆盖写入而不是重复插入", () => {
    setSetting(db, "scraper.minIntervalMs", "5000");
    setSetting(db, "scraper.minIntervalMs", "8000");
    expect(getSetting(db, "scraper.minIntervalMs")).toBe("8000");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("source credentials", () => {
  it("密文存取与覆盖、删除", () => {
    expect(findSourceCredential(db, "eh")).toBeNull();
    upsertSourceCredential(db, "eh", "sealed-v1");
    const first = findSourceCredential(db, "eh");
    expect(first?.payload).toBe("sealed-v1");
    expect(first?.updated_at).toBeTruthy();

    upsertSourceCredential(db, "eh", "sealed-v2");
    expect(findSourceCredential(db, "eh")?.payload).toBe("sealed-v2");

    deleteSourceCredential(db, "eh");
    expect(findSourceCredential(db, "eh")).toBeNull();
  });
});

describe("scrape cache", () => {
  it("未过期可读，过期返回 null", () => {
    writeScrapeCache(db, "eh:detail:100", { title: "缓存标题" }, 7);
    expect(readScrapeCache<{ title: string }>(db, "eh:detail:100")?.title).toBe("缓存标题");

    const future = new Date(Date.now() + 8 * 86_400_000);
    expect(readScrapeCache(db, "eh:detail:100", future)).toBeNull();
    expect(readScrapeCache(db, "eh:detail:missing")).toBeNull();
  });
});

describe("listScrapeCandidates", () => {
  it("只挑有 gid 且没有元数据的作品", () => {
    const library = createLibrary(db, { name: "本子", rootPath: "/data/books" });
    const fresh = addWork(library.id, "a", { gid: 100 });
    const withComicInfo = addWork(library.id, "b", { gid: 101, hasComicInfo: true });
    const withTags = addWork(library.id, "c", { gid: 102 });
    setWorkTags(db, withTags, [{ namespace: "language", name: "Chinese" }]);
    addWork(library.id, "d", { gid: null });

    const ids = listScrapeCandidates(db).map((work) => work.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(withComicInfo);
    expect(ids).not.toContain(withTags);
    expect(ids).toHaveLength(1);
  });

  it("force 忽略已有元数据，但仍跳过无 gid 的", () => {
    const library = createLibrary(db, { name: "本子", rootPath: "/data/books" });
    const withComicInfo = addWork(library.id, "b", { gid: 101, hasComicInfo: true });
    const withTags = addWork(library.id, "c", { gid: 102 });
    setWorkTags(db, withTags, [{ namespace: "language", name: "Chinese" }]);
    addWork(library.id, "d", { gid: null });

    const ids = listScrapeCandidates(db, { force: true }).map((work) => work.id);
    expect(ids).toContain(withComicInfo);
    expect(ids).toContain(withTags);
    expect(ids).toHaveLength(2);
  });

  it("按库过滤与 limit 生效", () => {
    const first = createLibrary(db, { name: "A", rootPath: "/data/a" });
    const second = createLibrary(db, { name: "B", rootPath: "/data/b" });
    for (let index = 0; index < 3; index += 1) addWork(first.id, `a-${index}`, { gid: 200 + index });
    addWork(second.id, "b-0", { gid: 300 });

    expect(listScrapeCandidates(db, { libraryId: first.id }).every((work) => work.library_id === first.id)).toBe(true);
    expect(listScrapeCandidates(db, { libraryId: second.id })).toHaveLength(1);
    expect(listScrapeCandidates(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("updateWorkMetadata", () => {
  it("回写标题/页数/ComicInfo 标记，不动路径", () => {
    const library = createLibrary(db, { name: "本子", rootPath: "/data/books" });
    const id = addWork(library.id, "work-a", { gid: 100 });
    updateWorkMetadata(db, id, { title: "新标题", pageCount: 128, hasComicInfo: true });

    const work = findWork(db, id);
    expect(work?.title).toBe("新标题");
    expect(work?.page_count).toBe(128);
    expect(work?.has_comicinfo).toBe(1);
    expect(work?.path).toBe("work-a");
  });

  it("空 patch 不报错也不改 updated_at", () => {
    const library = createLibrary(db, { name: "本子", rootPath: "/data/books" });
    const id = addWork(library.id, "work-b", { gid: 101 });
    const before = findWork(db, id)?.updated_at;
    updateWorkMetadata(db, id, {});
    expect(findWork(db, id)?.updated_at).toBe(before);
  });
});
