import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLibrary,
  createUser,
  createSession,
  findUserById,
  findUserByUsername,
  getProgress,
  getSessionUser,
  listLibraries,
  listWorkPages,
  listWorks,
  openDatabase,
  SCHEMA_VERSION,
  scanLibrary,
  setProgress,
  setWorkTags,
  listWorkTags,
  sweepExpiredSessions,
  toFtsQuery,
  type Db,
} from "@nekoshelf/core";

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
});

afterEach(() => {
  db.close();
});

describe("database", () => {
  it("建库后 user_version 为 SCHEMA_VERSION 且可重复 migrate", () => {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);
    expect(() => openDatabase({ path: ":memory:" })).not.toThrow();
  });

  it("用户与会话", () => {
    const user = createUser(db, { username: "admin", passwordHash: "hash" });
    expect(user.role).toBe("admin");
    expect(findUserByUsername(db, "ADMIN")?.id).toBe(user.id);
    expect(findUserById(db, user.id)?.username).toBe("admin");

    const sessionId = createSession(db, { userId: user.id, ttlMs: 60_000 });
    expect(getSessionUser(db, sessionId)?.id).toBe(user.id);

    createSession(db, { userId: user.id, ttlMs: -1 });
    sweepExpiredSessions(db);
    expect(getSessionUser(db, "not-a-session")).toBeUndefined();
  });

  it("媒体库与作品列表", () => {
    const library = createLibrary(db, { name: "本子", rootPath: "/data/books" });
    expect(listLibraries(db)).toHaveLength(1);
    expect(library.kind).toBe("mixed");

    const { items, total } = listWorks(db, { libraryId: library.id });
    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it("进度上报幂等更新", () => {
    const library = createLibrary(db, { name: "lib", rootPath: "/tmp/lib" });
    db.prepare(
      `INSERT INTO works (library_id, path, path_hash, title, kind, source_kind, page_count, created_at, updated_at)
       VALUES (?, 'a/b.zip', 'hash1', 'B', 'comic', 'archive', 10, '2026-01-01', '2026-01-01')`,
    ).run(library.id);
    const workId = Number(
      (db.prepare("SELECT id FROM works WHERE path_hash = 'hash1'").get() as { id: number }).id,
    );

    setProgress(db, workId, 3, 10);
    setProgress(db, workId, 5, 10);
    expect(getProgress(db, workId)).toMatchObject({ page: 5, page_count: 10 });
  });

  it("FTS 搜索防注入语法", () => {
    expect(toFtsQuery("ABC-123")).toBe('"ABC-123"*');
    expect(toFtsQuery('a "b* c')).toBe('"a"* AND "b"* AND "c"*');
    expect(toFtsQuery("   ")).toBe('""');
  });

  it("标签写入与回读", () => {
    const library = createLibrary(db, { name: "lib", rootPath: "/tmp/lib2" });
    db.prepare(
      `INSERT INTO works (library_id, path, path_hash, title, kind, source_kind, page_count, created_at, updated_at)
       VALUES (?, 'x', 'hash2', 'X', 'comic', 'directory', 3, '2026-01-01', '2026-01-01')`,
    ).run(library.id);
    const workId = Number(
      (db.prepare("SELECT id FROM works WHERE path_hash = 'hash2'").get() as { id: number }).id,
    );

    setWorkTags(db, workId, [
      { namespace: "artist", name: "某画师" },
      { namespace: "language", name: "zh" },
    ]);
    const labels = listWorkTags(db, workId).map((tag) =>
      tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name,
    );
    expect(labels).toContain("artist:某画师");
    expect(labels).toContain("language:zh");
  });
});

describe("scanner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nekoshelf-scan-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("扫描 EHViewer 目录：ComicInfo 标题、页数、自然序", async () => {
    const dir = join(root, "1883030-某作品 [汉化]");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "ComicInfo.xml"),
      `<?xml version="1.0"?><ComicInfo><Title>ComicInfo 标题</Title></ComicInfo>`,
    );
    for (const name of ["001.webp", "002.webp", "010.webp"]) {
      await writeFile(join(dir, name), "x");
    }

    const library = createLibrary(db, { name: "eh", rootPath: root });
    const summary = await scanLibrary(db, library, { onSkip: () => undefined });

    expect(summary.created).toBe(1);
    const { items } = listWorks(db, { libraryId: library.id });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("ComicInfo 标题");
    expect(items[0]?.gid).toBe(1883030);
    expect(items[0]?.kind).toBe("comic");
    expect(items[0]?.page_count).toBe(3);

    const pages = listWorkPages(db, items[0]!.id);
    expect(pages.map((page) => page.name)).toEqual(["001.webp", "002.webp", "010.webp"]);
  });

  it("二次扫描不重复入库（增量）", async () => {
    const dir = join(root, "1000001-作品");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.jpg"), "x");
    await writeFile(join(dir, "b.jpg"), "x");
    await writeFile(join(dir, "c.jpg"), "x");

    const library = createLibrary(db, { name: "eh2", rootPath: root });
    await scanLibrary(db, library, { onSkip: () => undefined });
    const second = await scanLibrary(db, library, { onSkip: () => undefined });

    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(listWorks(db, { libraryId: library.id }).total).toBe(1);
  });

  it("视频按番号归并主片，广告文件跳过", async () => {
    const dir = join(root, "av");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "XYZ-456_CH_SD.mp4"), "x");
    await writeFile(join(dir, "ads.com@ABC-123.mp4"), "x");
    await writeFile(join(dir, "2048社区最新地址.mp4"), "x");

    const skipped: string[] = [];
    const library = createLibrary(db, { name: "av", rootPath: root });
    const summary = await scanLibrary(db, library, {
      onSkip: (skip) => skipped.push(skip.reason),
    });

    const { items } = listWorks(db, { libraryId: library.id });
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(["video", "video"]);
    expect(items.map((item) => item.title).sort()).toEqual(["ABC-123", "XYZ-456"]);
    expect(skipped.some((reason) => reason.includes("广告"))).toBe(true);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("忽略隐藏目录、下载中文件与符号链接", async () => {
    const workDir = join(root, "works", "2000001-x");
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "1.jpg"), "x");
    await writeFile(join(workDir, "2.jpg"), "x");
    await writeFile(join(workDir, "3.jpg"), "x");
    await writeFile(join(workDir, "3.jpg.pptd"), "partial");
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, ".hidden", "a.jpg"), "x");
    try {
      await symlink(workDir, join(root, "linked"), "dir");
    } catch {
      // Windows 上无权限创建符号链接时跳过该断言
    }

    const library = createLibrary(db, { name: "skip", rootPath: root });
    await scanLibrary(db, library, { onSkip: () => undefined });

    const { items } = listWorks(db, { libraryId: library.id });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("x");
    expect(items[0]?.page_count).toBe(3);
  });
it("thumb.webp 不算书页（EhViewer 预览图），且目录名可反推 gid", async () => {
    const workDir = join(root, "2874658-猫の幼虫~测试");
    await mkdir(workDir, { recursive: true });
    for (const name of ["00000001.webp", "00000002.webp", "00000003.webp", "thumb.webp"]) {
      await writeFile(join(workDir, name), "x");
    }

    const library = createLibrary(db, { name: "thumbs", rootPath: root });
    await scanLibrary(db, library);

    const { items } = listWorks(db, { libraryId: library.id });
    expect(items).toHaveLength(1);
    expect(items[0]?.page_count).toBe(3);
    expect(items[0]?.gid).toBe(2874658);
  });
});
