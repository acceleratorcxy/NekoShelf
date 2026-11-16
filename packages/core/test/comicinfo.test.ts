import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comicInfoToTags,
  createLibrary,
  listWorkTags,
  listWorks,
  openDatabase,
  parseComicInfo,
  scanLibrary,
  type Db,
} from "@nekoshelf/core";
import type { LibraryRow } from "@nekoshelf/core";

const COMIC_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<ComicInfo>
  <Title><![CDATA[夏の終わり & 約束]]></Title>
  <Series>Summer Collection</Series>
  <Number>3</Number>
  <Summary>两个人 &amp; 一个夏天的故事</Summary>
  <Writer>作者甲</Writer>
  <Penciller>画师乙</Penciller>
  <Genre>Drama, Romance</Genre>
  <Tags>NTR，百合</Tags>
  <LanguageISO>zh</LanguageISO>
  <PageCount>42</PageCount>
  <Year>2024</Year>
</ComicInfo>`;

let db: Db;
let root: string;
let library: LibraryRow;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "neko-comicinfo-"));
  library = createLibrary(db, { name: "测试库", rootPath: root, kind: "comic" });

  // 一部带 ComicInfo 的漫画
  const comicDir = join(root, "comic1");
  await mkdir(comicDir, { recursive: true });
  await writeFile(join(comicDir, "ComicInfo.xml"), COMIC_INFO);
  for (let i = 1; i <= 3; i += 1) {
    await writeFile(join(comicDir, `${String(i).padStart(3, "0")}.jpg`), "x");
  }

  // 一部无元数据的图集
  const setDir = join(root, "set1");
  await mkdir(setDir, { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    await writeFile(join(setDir, `image_${i}.jpg`), "x");
  }

  // 一部视频
  const videoDir = join(root, "video1");
  await mkdir(videoDir, { recursive: true });
  await writeFile(join(videoDir, "ABC-123.mp4"), "x");
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("ComicInfo 解析", () => {
  it("解析标题/CDATA/实体/标签/语言/页数", () => {
    const meta = parseComicInfo(COMIC_INFO);
    expect(meta.title).toBe("夏の終わり & 約束");
    expect(meta.series).toBe("Summer Collection");
    expect(meta.writer).toBe("作者甲");
    expect(meta.penciller).toBe("画师乙");
    expect(meta.genres).toEqual(["Drama", "Romance"]);
    expect(meta.tags).toEqual(["NTR", "百合"]);
    expect(meta.language).toBe("zh");
    expect(meta.pageCount).toBe(42);
    expect(meta.year).toBe(2024);
    expect(meta.summary).toBe("两个人 & 一个夏天的故事");
  });

  it("字段缺失时返回空集合，不抛异常", () => {
    const meta = parseComicInfo("<ComicInfo><Title></Title></ComicInfo>");
    expect(meta.title).toBeUndefined();
    expect(meta.genres).toEqual([]);
    expect(meta.tags).toEqual([]);
  });

  it("映射到 tag / artist / series / language 命名空间并去重", () => {
    const tags = comicInfoToTags(parseComicInfo(COMIC_INFO));
    const asKey = tags.map((tag) => `${tag.namespace}:${tag.name}`);
    expect(asKey).toContain("tag:Drama");
    expect(asKey).toContain("tag:百合");
    expect(asKey).toContain("artist:作者甲");
    expect(asKey).toContain("artist:画师乙");
    expect(asKey).toContain("series:Summer Collection");
    expect(asKey).toContain("language:zh");
    expect(tags.filter((tag) => tag.namespace === "tag")).toHaveLength(4);
  });
});

describe("扫描时索引本地元数据", () => {
  it("扫描后按 ComicInfo 标签与作者可搜索，并写入 tags 表", async () => {
    await scanLibrary(db, library);

    const byWriter = listWorks(db, { q: "作者甲" });
    expect(byWriter.total).toBe(1);
    expect(byWriter.items[0]?.title).toContain("夏の終わり");

    const byGenre = listWorks(db, { q: "Drama" });
    expect(byGenre.total).toBe(1);

    const workId = byWriter.items[0]?.id;
    expect(workId).toBeTypeOf("number");
    const tags = listWorkTags(db, workId as number);
    const asKey = tags.map((tag) => `${tag.namespace}:${tag.name}`);
    expect(asKey).toContain("artist:作者甲");
    expect(asKey).toContain("tag:百合");
  });

  it("漫画 / 图集 / 视频可以按 kind 分开查询", async () => {
    await scanLibrary(db, library);

    const comics = listWorks(db, { kind: "comic" });
    const sets = listWorks(db, { kind: "image-set" });
    const videos = listWorks(db, { kind: "video" });

    expect(comics.total).toBe(1);
    expect(sets.total).toBe(1);
    expect(videos.total).toBe(1);
    expect(videos.items[0]?.title.toLowerCase()).toContain("abc-123");
  });
});
