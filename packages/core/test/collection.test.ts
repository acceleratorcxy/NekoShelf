import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLibrary,
  listWorkChapters,
  listWorkPeople,
  listWorks,
  openDatabase,
  scanLibrary,
  type Db,
} from "@nekoshelf/core";

let db: Db;
let root: string;

async function writeDir(base: string, files: string[], content = "x"): Promise<void> {
  await mkdir(base, { recursive: true });
  for (const file of files) {
    await writeFile(join(base, file), file.endsWith(".jpg") ? Buffer.from([0xff, 0xd8, 0xff]) : content);
  }
}

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "neko-collection-"));
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("合集归并与章节", () => {
  it("真人合集杂图：同名作者下的日期/套图目录合并为一个合集，并生成章节", async () => {
    await writeDir(join(root, "真人合集杂图/作者甲/2024-01-01"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "真人合集杂图/作者甲/NO.01"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "真人合集杂图/作者甲/2024-02-02"), ["1.jpg", "2.jpg", "3.jpg"]);
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "mixed" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(1);
    const work = works[0]!;
    expect(work.kind).toBe("image-set");
    expect(work.path).toBe("真人合集杂图/作者甲");
    expect(work.page_count).toBe(9);
    const chapters = listWorkChapters(db, work.id);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toMatchObject({ start_page: 1 });
    expect(chapters[1]!.start_page).toBeGreaterThanOrEqual(2);
  });

  it("视频剧集：一个目录下的多话视频合并为一个视频作品，每话一章", async () => {
    await writeDir(join(root, "av/番剧/第01话"), ["01.mp4"], "v1");
    await writeDir(join(root, "av/番剧/第02话"), ["01.mp4"], "v2");
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "video" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("video");
    expect(works[0]!.path).toBe("av/番剧");
    const chapters = listWorkChapters(db, works[0]!.id);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.rel_path).toBe("第01话/01.mp4");
  });

  it("从路径推导作者：杂/作者合集/<作者> 与真人合集杂图/<作者>", async () => {
    await writeDir(join(root, "杂/作者合集/uof/18theresia"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "杂/作者合集/uof/20theresa2"), ["1.jpg", "2.jpg", "3.jpg"]);
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "mixed" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(1);
    const people = listWorkPeople(db, works[0]!.id);
    expect(people.map((person) => person.name)).toContain("uof");
  });

  it("本子里的多卷/多话目录：合并为一个漫画作品，每卷一章", async () => {
    await writeDir(join(root, "本子/tmp/作者丁/作品戊/第01话"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "本子/tmp/作者丁/作品戊/第02话"), ["1.jpg", "2.jpg", "3.jpg"]);
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "comic" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("comic");
    expect(works[0]!.path).toBe("本子/tmp/作者丁/作品戊");
    const chapters = listWorkChapters(db, works[0]!.id);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.title).toContain("第01话");
  });

  it("同一目录下的多集视频：合并为一个视频作品，每集一章", async () => {
    await writeDir(join(root, "av/真人剧"), ["EP-001.mp4", "EP-002.mp4"], "v");
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "video" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("video");
    expect(works[0]!.path).toBe("av/真人剧");
    const chapters = listWorkChapters(db, works[0]!.id);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.rel_path).toBe("EP-001.mp4");
  });

  it("系列归并：同作者 + 相似标题（卷号不同）归为一个系列；占位标题不归并", async () => {
    await writeDir(join(root, "本子/tmp/作者乙/作品丙 第01卷"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "本子/tmp/作者乙/作品丙 第02卷"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "本子/tmp/作者乙/notext"), ["1.jpg", "2.jpg", "3.jpg"]);
    await writeDir(join(root, "本子/tmp/作者乙/notext（1）"), ["1.jpg", "2.jpg", "3.jpg"]);
    const library = createLibrary(db, { name: "库", rootPath: root, kind: "comic" });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items: works } = listWorks(db, { libraryId: library.id });
    expect(works).toHaveLength(4);
    const seriesWorks = works.filter((work) => work.series_id !== null);
    expect(seriesWorks).toHaveLength(2);
    expect(new Set(seriesWorks.map((work) => work.series_id)).size).toBe(1);
  });
});
