/**
 * 相关推荐：同作者合集目录下、没有 E-H 元数据的作品也要能互相推荐。
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, openDatabase, upsertWork, relatedWorkGroups, type Db } from "../src/index.js";

describe("related works by name/folder", () => {
  let db: Db;
  let dir: string;
  let libraryId: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-related-"));
    db = openDatabase({ path: join(dir, "neko.db") });
    libraryId = createLibrary(db, { name: "库", rootPath: dir }).id;
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("同作者目录下的不同系列（标题都叫 notext）互相推荐", () => {
    const a = upsertWork(db, {
      libraryId,
      relativePath: "杂/作者合集/uof/18theresia/notext",
      title: "notext",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 22,
    }).id;
    const b = upsertWork(db, {
      libraryId,
      relativePath: "杂/作者合集/uof/20theresa2/notext",
      title: "notext",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 23,
    }).id;
    upsertWork(db, {
      libraryId,
      relativePath: "杂/作者合集/uof/21Ex/Notext",
      title: "Notext",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 7,
    });
    // 无关作品不应出现
    upsertWork(db, {
      libraryId,
      relativePath: "av/DASS-286",
      title: "DASS-286",
      kind: "video",
      sourceKind: "video",
      pageCount: 1,
    });

    const groups = relatedWorkGroups(db, a);
    const nameIds = groups.name.map((row) => row.id);
    expect(nameIds).toContain(b);
    expect(groups.name.some((row) => row.title === "DASS-286")).toBe(false);
  });

  it("同目录同名前缀的系列也能推荐", () => {
    const a = upsertWork(db, {
      libraryId,
      relativePath: "杂/作者合集/uof/26_zofia/x",
      title: "26_zofia",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 10,
    }).id;
    const b = upsertWork(db, {
      libraryId,
      relativePath: "杂/作者合集/uof/28_zofia2/y",
      title: "28_zofia2",
      kind: "image-set",
      sourceKind: "directory",
      pageCount: 12,
    }).id;
    const groups = relatedWorkGroups(db, a);
    expect(groups.name.map((row) => row.id)).toContain(b);
  });
});
