/**
 * 整理 / NFO / 重复合并路由集成测试：只使用临时目录，验证写回安全门禁与 dry-run 计划。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, upsertWork, type Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("organize routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let dir: string;
  let root: string;
  let libraryId: number;
  let workA: number;
  let workB: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-organize-"));
    root = join(dir, "media");
    await mkdir(join(root, "old", "a"), { recursive: true });
    await writeFile(join(root, "old", "a", "001.jpg"), "x");
    await mkdir(join(root, "old", "b"), { recursive: true });
    await writeFile(join(root, "old", "b", "001.jpg"), "x");
    const config = loadConfig({
      CONFIG_DIR: join(dir, "config"),
      CACHE_DIR: join(dir, "cache"),
      DATA_MODE: "writeback",
    });
    ({ app, db } = await createApp(config));
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "admin", password: "testpass123" },
    });
    const sid = setup.cookies.find((item) => item.name === "sid")?.value;
    cookie = `sid=${sid}`;
    libraryId = createLibrary(db, { name: "媒体库", rootPath: root }).id;
    workA = upsertWork(db, {
      libraryId,
      relativePath: "old/a",
      title: "作品A",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 8,
      dupKey: "same-title",
    }).id;
    workB = upsertWork(db, {
      libraryId,
      relativePath: "old/b",
      title: "作品B",
      kind: "comic",
      sourceKind: "directory",
      pageCount: 8,
      dupKey: "same-title",
    }).id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function inject(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { cookie }, payload: payload as object });
  }

  it("默认状态：写回可用但整理开关关闭", async () => {
    const res = await inject("GET", "/api/organize");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { organize: { enabled: boolean; writebackEnabled: boolean; pattern: string } };
    expect(body.organize.writebackEnabled).toBe(true);
    expect(body.organize.enabled).toBe(false);
    expect(body.organize.pattern).toContain("{title}");
  });

  it("模板保存与非法输入", async () => {
    expect((await inject("PUT", "/api/organize", { pattern: "" })).statusCode).toBe(400);
    const ok = await inject("PUT", "/api/organize", { pattern: "{title} [{pages}P]" });
    expect(ok.statusCode).toBe(200);
    const state = (await inject("GET", "/api/organize")).json() as { organize: { pattern: string } };
    expect(state.organize.pattern).toBe("{title} [{pages}P]");
  });

  it("dry-run 预览生成目标路径与重复目标冲突", async () => {
    await inject("PUT", "/api/organize", { pattern: "{title}" });
    db.prepare("UPDATE works SET title = ? WHERE id = ?").run("同名", workA);
    db.prepare("UPDATE works SET title = ? WHERE id = ?").run("同名", workB);
    const res = await inject("GET", `/api/organize/preview?libraryId=${libraryId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ from: string; to: string; conflict: string | null }>;
      conflictCount: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.to).toBe(`${root}/同名`);
    expect(body.conflictCount).toBe(1);
    expect(body.items.some((item) => item.conflict?.startsWith("duplicate_target"))).toBe(true);
  });

  it("NFO 预览只读且包含作品元数据", async () => {
    const res = await inject("GET", `/api/works/${workA}/nfo`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { filename: string; content: string };
    expect(body.filename).toBe("作品A.nfo");
    expect(body.content).toContain("<title>作品A</title>");
    expect(body.content).toContain("<pagecount>8</pagecount>");
    expect(await fileExists(join(root, "old", "a", "作品A.nfo"))).toBe(false);
  });

  it("重复组与合并预览", async () => {
    const groups = (await inject("GET", "/api/duplicates")).json() as {
      groups: Array<{ key: string; count: number }>;
    };
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]?.count).toBe(2);
    const plan = (await inject("POST", "/api/duplicates/preview-merge", { keepId: workA })).json() as {
      plan: { keepId: number; dropIds: number[] };
    };
    expect(plan.plan.keepId).toBe(workA);
    expect(plan.plan.dropIds).toEqual([workB]);
  });

  it("未开启整理时 apply 被拒绝", async () => {
    const res = await inject("POST", "/api/organize/apply", { libraryId, confirm: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("organize_disabled");
  });

  it("开启整理 + confirm 后真实重命名并留 journal", async () => {
    await inject("PUT", "/api/organize", { pattern: "{title}", enabled: true });
    const res = await inject("POST", "/api/organize/apply", { libraryId, confirm: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: number; journalPath: string };
    expect(body.applied).toBe(2);
    expect(await fileExists(join(root, "作品A", "001.jpg"))).toBe(true);
    expect(await fileExists(join(root, "old", "a"))).toBe(false);
    expect(await fileExists(body.journalPath)).toBe(true);
  });

  it("NFO 写回：未开开关被拒，开启后落盘并可撤销", async () => {
    const denied = await inject("POST", `/api/works/${workA}/nfo`, { confirm: true });
    expect(denied.statusCode).toBe(409);

    await inject("PUT", "/api/organize", { enabled: true, nfo: true });
    const res = await inject("POST", `/api/works/${workA}/nfo`, { confirm: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { path: string; journalId: string };
    expect(await fileExists(join(root, "old", "a", "作品A.nfo"))).toBe(true);

    // 重复写入且无 force → 冲突
    const conflict = await inject("POST", `/api/works/${workA}/nfo`, { confirm: true });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe("target_exists");

    // force 覆盖成功
    expect((await inject("POST", `/api/works/${workA}/nfo`, { confirm: true, force: true })).statusCode).toBe(200);

    const journal = (await inject("GET", "/api/organize/journal")).json() as {
      entries: Array<{ id: string; type: string }>;
    };
    expect(journal.entries.some((entry) => entry.id === body.journalId)).toBe(true);

    const undo = await inject("POST", `/api/organize/undo/${body.journalId}`);
    expect(undo.statusCode).toBe(200);
    expect(await fileExists(join(root, "old", "a", "作品A.nfo"))).toBe(false);
  });

  it("合并写回：隐藏副本、详情计数可查、撤销恢复", async () => {
    const res = await inject("POST", "/api/works/merge", { keepId: workA, confirm: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { merged: number; dropIds: number[]; journalId: string };
    expect(body.merged).toBe(1);
    expect(body.dropIds).toEqual([workB]);

    const list = (await inject("GET", `/api/works?libraryId=${libraryId}`)).json() as {
      items: Array<{ id: number }>;
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.items.map((item) => item.id)).toEqual([workA]);

    const detail = (await inject("GET", `/api/works/${workA}`)).json() as {
      work: { mergedCount?: number };
    };
    expect(detail.work.mergedCount).toBe(1);

    const undo = await inject("POST", `/api/organize/undo/${body.journalId}`);
    expect(undo.statusCode).toBe(200);
    const after = (await inject("GET", `/api/works?libraryId=${libraryId}`)).json() as { total: number };
    expect(after.total).toBe(2);
  });

  it("撤销未知 journal 返回 404", async () => {
    const res = await inject("POST", "/api/organize/undo/nfo-9999999999999");
    expect(res.statusCode).toBe(404);
  });
});
