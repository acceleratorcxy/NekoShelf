import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLibrary,
  discoverWorks,
  findJob,
  listSkipRecords,
  openDatabase,
  scanLibrary,
  type Db,
  type DiscoveredWork,
} from "@nekoshelf/core";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "neko-discover-"));
  db = openDatabase({ path: ":memory:" });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function imageDir(rel: string, count = 3): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(abs, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    await writeFile(join(abs, `${String(i).padStart(3, "0")}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
  }
}

async function collect(root: string, options = {}): Promise<{ works: DiscoveredWork[]; skips: string[]; notes: string[] }> {
  const works: DiscoveredWork[] = [];
  const skips: string[] = [];
  const notes: string[] = [];
  for await (const work of discoverWorks(root, {
    ...options,
    onSkip: (skip) => skips.push(`${skip.path}:${skip.reason}`),
    onNote: (note) => notes.push(`${note.path}:${note.reason}`),
  })) {
    works.push(work);
  }
  return { works, skips, notes };
}

describe("库根目录散落无番号视频（P0-1）", () => {
  it("不会截断整棵子树，仍能扫到子目录作品", async () => {
    await writeFile(join(dir, "散落视频.mp4"), Buffer.alloc(16));
    await imageDir("合集A");
    await imageDir("合集B");

    const { works, notes } = await collect(dir);
    expect(works.map((work) => work.relativePath).sort()).toEqual(["合集A", "合集B"]);
    // 结构提示不再计入「跳过」（会误导用户以为漏扫）
    expect(notes.some((line) => line.includes("已继续扫描其子目录"))).toBe(true);
  });

  it("没有子目录时只跳过视频，不产出作品", async () => {
    await writeFile(join(dir, "散落视频.mp4"), Buffer.alloc(16));
    const { works } = await collect(dir);
    expect(works).toHaveLength(0);
  });
});

describe("未匹配视频策略", () => {
  it("as-work 时无番号视频作为普通视频作品入库", async () => {
    await writeFile(join(dir, "真人合集 01.mp4"), Buffer.alloc(16));
    const { works } = await collect(dir, { unmatchedVideoPolicy: "as-work" });
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("video");
    expect(works[0]!.title).toContain("真人合集 01");
  });

  it("skip 时记录广告/干扰跳过", async () => {
    await writeFile(join(dir, "广告.mp4"), Buffer.alloc(16));
    const { works, skips } = await collect(dir);
    expect(works).toHaveLength(0);
    expect(skips.some((line) => line.includes("广告/干扰"))).toBe(true);
  });
});

describe("目录内图片+子目录（P0-2）", () => {
  it("有子目录时继续下钻，广告图不会遮蔽子目录里的视频", async () => {
    const av = join(dir, "av");
    await mkdir(join(av, "DASS-286"), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      await writeFile(join(av, `ad${i}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
    }
    await writeFile(join(av, "DASS-286", "kcf9.com@DASS-286.mp4"), Buffer.alloc(16));

    const { works, notes } = await collect(dir);
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("video");
    expect(works[0]!.code).toBe("DASS-286");
    expect(notes.some((line) => line.includes("按容器目录继续下钻"))).toBe(true);
  });

  it("无子目录的图片目录仍按图集入库", async () => {
    await imageDir("套图");
    const { works } = await collect(dir);
    expect(works).toHaveLength(1);
    expect(works[0]!.kind).toBe("image-set");
  });
});

describe("扫描汇总与诊断", () => {
  it("报告遍历目录数，零作品时写诊断跳过记录", async () => {
    await writeFile(join(dir, "散落.mp4"), Buffer.alloc(16));
    const library = createLibrary(db, { name: "lib", rootPath: dir, kind: "mixed" });
    const summary = await scanLibrary(db, library);
    expect(summary.works).toBe(0);
    expect(summary.directories).toBe(1);

    const job = findJob(db, summary.jobId);
    expect(job?.message).toContain("扫描 1 个目录");

    const skips = listSkipRecords(db, library.id, 50);
    expect(skips.some((skip) => skip.reason.includes("未产出作品"))).toBe(true);
  });
});
