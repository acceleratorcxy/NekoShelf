import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotatePages,
  createLibrary,
  detectArchiveKind,
  discoverWorks,
  findCounterpart,
  resolveArchiveTool,
  findDuplicateCandidates,
  findLanguageVariant,
  groupPagePairs,
  languageOf,
  listArchiveEntries,
  listPagePairLinks,
  listWorkPages,
  findWork,
  openDatabase,
  pairKeyOf,
  upsertWork,
  type Db,
} from "@nekoshelf/core";

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
});

afterEach(() => {
  db.close();
});

/** 与镜像/开发机一致的压缩包工具是否可用（不可用时相关用例跳过）。 */
function archiveToolAvailable(): boolean {
  try {
    const result = spawnSync(resolveArchiveTool(), ["i"], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

describe("双语页配对", () => {
  it("识别 MANA 双语包的 `_A` / `_A_CN` 配对", () => {
    const entries = [
      { name: "YeShunguang01_A.png" },
      { name: "YeShunguang01_A_CN.jpg" },
      { name: "YeShunguang02_A.png" },
      { name: "YeShunguang02_A_CN.jpg" },
    ];
    expect(languageOf("YeShunguang01_A.png")).toBe("");
    expect(languageOf("YeShunguang01_A_CN.jpg")).toBe("zh");
    expect(pairKeyOf("YeShunguang01_A.png")).toBe(pairKeyOf("YeShunguang01_A_CN.jpg"));

    const groups = groupPagePairs(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.languages.sort()).toEqual(["", "zh"]);
    expect(findCounterpart(entries, "YeShunguang01_A.png", "zh")).toBe(
      "YeShunguang01_A_CN.jpg",
    );
  });

  it("单语言包不产生配对；中文繁体标记归一", () => {
    const groups = groupPagePairs([{ name: "001.png" }, { name: "002.png" }]);
    expect(groups).toHaveLength(0);
    expect(languageOf("003_CN.png")).toBe("zh");
    expect(languageOf("003_ENG.png")).toBe("en");
    expect(languageOf("003_JP.png")).toBe("ja");
    expect(languageOf("封面_繁體.png")).toBe("zh-Hant");
  });

  it("annotatePages 给每页补 lang 与 pairKey", () => {
    const annotated = annotatePages([{ name: "dir/01_A.png", size: 10 }]);
    expect(annotated[0]?.lang).toBe("");
    expect(annotated[0]?.pairKey).toBe("dir/01_a");
    expect(annotated[0]?.size).toBe(10);
  });
});

describe("数据层：配对信息与疑似重复", () => {
  it("listPagePairLinks 标出对照页", () => {
    const library = createLibrary(db, { name: "pair", rootPath: "/data/pair" });
    const { id } = upsertWork(db, {
      libraryId: library.id,
      relativePath: "w1",
      title: "配对页",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 2,
      pages: [
        { name: "01_A.png", lang: "", pairKey: "01_a" },
        { name: "01_A_CN.jpg", lang: "zh", pairKey: "01_a" },
      ],
    });
    const links = listPagePairLinks(db, id);
    expect(links).toHaveLength(2);
    expect(links[0]?.variantOf).toBe(2);
    expect(links[1]?.variantOf).toBe(1);
    expect(links[1]?.lang).toBe("zh");
  });

  it("findLanguageVariant 取到同键的中文版", () => {
    const library = createLibrary(db, { name: "pair2", rootPath: "/data/pair2" });
    const { id } = upsertWork(db, {
      libraryId: library.id,
      relativePath: "w2",
      title: "配对页2",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 2,
      pages: [
        { name: "01.png", lang: "", pairKey: "01" },
        { name: "01_CN.png", lang: "zh", pairKey: "01" },
      ],
    });
    const pages = listWorkPages(db, id);
    const variant = findLanguageVariant(db, id, pages[0]!, "zh");
    expect(variant?.name).toBe("01_CN.png");
  });

  it("标题归一化后相同的作品互为疑似重复", () => {
    const library = createLibrary(db, { name: "dup", rootPath: "/data/dup" });
    const a = upsertWork(db, {
      libraryId: library.id,
      relativePath: "a",
      title: "[汉化组]五等分の花嫁",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 3,
    });
    const b = upsertWork(db, {
      libraryId: library.id,
      relativePath: "b",
      title: "【XYZ】五等分の花嫁",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 3,
    });
    const workA = findWork(db, a.id)!;
    const candidates = findDuplicateCandidates(db, workA);
    expect(candidates.map((item) => item.id)).toContain(b.id);
    expect(candidates[0]?.reason).toBe("title");
  });

  it("页数与体积完全一致视为「精确重复」", () => {
    const library = createLibrary(db, { name: "dup2", rootPath: "/data/dup2" });
    const a = upsertWork(db, {
      libraryId: library.id,
      relativePath: "x",
      title: "作品 X",
      kind: "comic",
      sourceKind: "archive",
      pageCount: 30,
      sizeBytes: 123456,
    });
    const b = upsertWork(db, {
      libraryId: library.id,
      relativePath: "y",
      title: "另一个名字",
      kind: "comic",
      sourceKind: "archive",
      pageCount: 30,
      sizeBytes: 123456,
    });
    const workA = findWork(db, a.id)!;
    const candidates = findDuplicateCandidates(db, workA);
    expect(candidates.find((item) => item.id === b.id)?.reason).toBe("exact");
  });
});

describe("扫描目录判定：混合目录（散图 + 压缩包）", () => {
  it("少量散图 + 压缩包 → 按压缩包作品入库，不能整体漏掉", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-mixed-"));
    try {
      await writeFile(join(dir, "040.jpg"), "fake-bytes");
      await writeFile(join(dir, "a.zip"), "fake-bytes");
      const found: string[] = [];
      for await (const work of discoverWorks(dir)) found.push(`${work.sourceKind}:${work.relativePath}`);
      expect(found).toEqual(["archive:a.zip"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("≥3 张图片 + 压缩包 → 图片作品优先，压缩包不重复入库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-mixed2-"));
    try {
      for (const name of ["001.jpg", "002.jpg", "003.jpg"]) await writeFile(join(dir, name), "x");
      await writeFile(join(dir, "pages.zip"), "fake-bytes");
      const found: string[] = [];
      for await (const work of discoverWorks(dir)) found.push(`${work.sourceKind}:${work.files.length}`);
      expect(found).toEqual(["directory:3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("多格式压缩包", () => {
  const skip = !archiveToolAvailable();

  it.skipIf(skip)("zip：中央目录列表 + 自然序 + 过滤 thumb/垃圾文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-zip-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      for (const name of ["img10.jpg", "img2.jpg", "img1.jpg", "thumb.webp"]) {
        await writeFile(join(dir, "src", name), "fake-bytes");
      }
      const tool = resolveArchiveTool();
      const zipPath = join(dir, "sample.zip");
      const create = spawnSync(
        tool,
        ["a", "-tzip", "-y", zipPath, join(dir, "src", "*.jpg"), join(dir, "src", "thumb.webp")],
        { cwd: dir },
      );
      expect(create.status).toBe(0);
      expect(await detectArchiveKind(zipPath)).toBe("zip");
      const listing = await listArchiveEntries(zipPath);
      expect(listing.error).toBeUndefined();
      expect(listing.pages.map((page) => page.name).slice(0, 3)).toEqual([
        "img1.jpg",
        "img2.jpg",
        "img10.jpg",
      ]);
      expect(listing.pages.some((page) => page.name.includes("thumb"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(skip)("7z：用 7zz 列条目，不解压", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-7z-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      for (const name of ["001.jpg", "002.jpg", "003.jpg"]) {
        await writeFile(join(dir, "src", name), "fake-bytes");
      }
      const tool = resolveArchiveTool();
      const archivePath = join(dir, "sample.7z");
      const create = spawnSync(
        tool,
        ["a", "-t7z", "-y", archivePath, join(dir, "src", "*.jpg")],
        { cwd: dir },
      );
      expect(create.status).toBe(0);
      expect(await detectArchiveKind(archivePath)).toBe("7z");
      const listing = await listArchiveEntries(archivePath);
      expect(listing.error).toBeUndefined();
      expect(listing.pages).toHaveLength(3);
      expect(listing.pages.map((page) => page.name)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("非压缩包（伪装文件）返回 unknown 而不是抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neko-fake-"));
    try {
      const fake = join(dir, "fake.cbz");
      await writeFile(fake, Buffer.from("not a zip at all"));
      expect(await detectArchiveKind(fake)).toBe("unknown");
      const listing = await listArchiveEntries(fake);
      expect(listing.error).toBeTruthy();
      expect(listing.pages).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
