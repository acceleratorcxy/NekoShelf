import type { FastifyInstance } from "fastify";
import type { Db, WorkRow } from "@nekoshelf/core";
import {
  DEFAULT_RENAME_PATTERN,
  buildNfo,
  buildRenameTarget,
  findLibrary,
  findWork,
  getSetting,
  getSettingBoolean,
  listWorkTags,
  listWorks,
  mergeWorks,
  nfoFileName,
  planMerge,
  setSetting,
} from "@nekoshelf/core";
import type { AppConfig } from "../config.js";
import { listJournal, undoJournal, writeJournal, type JournalEntry } from "../journal.js";
import { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

interface OrganizeItem {
  workId: number;
  title: string;
  kind: string;
  pages: number;
  from: string;
  to: string;
  conflict: string | null;
}

function templateVars(work: WorkRow): Record<string, string | number | undefined> {
  return {
    title: work.title,
    pages: work.page_count,
    gid: work.gid ?? undefined,
    kind: work.kind,
  };
}

function insideRoot(root: string, target: string): boolean {
  const base = resolve(root) + sep;
  return resolve(target).startsWith(base);
}

function buildPlan(db: Db, libraryId: number, pattern: string, limit: number): OrganizeItem[] {
  const library = findLibrary(db, libraryId);
  if (!library) return [];
  const items: OrganizeItem[] = [];
  let page = 1;
  while (items.length < limit) {
    const result = listWorks(db, { libraryId, page, pageSize: Math.min(100, limit) });
    if (result.items.length === 0) break;
    for (const work of result.items) {
      const target = buildRenameTarget(join(library.root_path, work.path), library.root_path, pattern, templateVars(work));
      items.push({
        workId: work.id,
        title: work.title,
        kind: work.kind,
        pages: work.page_count,
        from: target.from,
        to: target.to,
        conflict: target.conflict,
      });
      if (items.length >= limit) break;
    }
    if (page * Math.min(100, limit) >= result.total) break;
    page += 1;
  }
  // 同批内重复目标标记冲突（避免一键整理时互相覆盖）。
  const seen = new Map<string, number>();
  for (const item of items) {
    if (item.conflict) continue;
    const key = item.to.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) item.conflict = `duplicate_target:${first}`;
    else seen.set(key, item.workId);
  }
  return items;
}

export function registerOrganizeRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const writebackEnabled = config.dataMode === "writeback";

  app.get("/api/organize", async () => {
    const enabled = writebackEnabled && getSettingBoolean(db, "organize.enabled", false);
    return {
      organize: {
        enabled,
        writebackEnabled,
        pattern: getSetting(db, "organize.pattern") ?? DEFAULT_RENAME_PATTERN,
        nfoEnabled: writebackEnabled && getSettingBoolean(db, "organize.nfo", false),
      },
    };
  });

  app.put("/api/organize", async (request, reply) => {
    const body = (request.body ?? {}) as { enabled?: unknown; pattern?: unknown; nfo?: unknown };
    if (typeof body.pattern === "string") {
      const pattern = body.pattern.trim();
      if (pattern.length === 0 || pattern.length > 200) {
        return reply.code(400).send({ error: { code: "invalid_pattern", message: "模板不能为空且不超过 200 字" } });
      }
      setSetting(db, "organize.pattern", pattern);
    }
    if (typeof body.enabled === "boolean") {
      if (body.enabled && !writebackEnabled) {
        return reply
          .code(409)
          .send({ error: { code: "writeback_disabled", message: "需要容器以 DATA_MODE=writeback 启动" } });
      }
      setSetting(db, "organize.enabled", body.enabled ? "1" : "0");
    }
    if (typeof body.nfo === "boolean") {
      if (body.nfo && !writebackEnabled) {
        return reply
          .code(409)
          .send({ error: { code: "writeback_disabled", message: "需要容器以 DATA_MODE=writeback 启动" } });
      }
      setSetting(db, "organize.nfo", body.nfo ? "1" : "0");
    }
    return { ok: true, writebackEnabled };
  });

  app.get("/api/organize/preview", async (request, reply) => {
    const query = (request.query ?? {}) as { libraryId?: string; limit?: string; pattern?: string };
    const libraryId = Number(query.libraryId ?? 0);
    if (!Number.isInteger(libraryId) || libraryId <= 0) {
      return reply.code(400).send({ error: { code: "invalid_library", message: "缺少 libraryId" } });
    }
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
    const pattern = (query.pattern ?? getSetting(db, "organize.pattern") ?? DEFAULT_RENAME_PATTERN).trim();
    const library = findLibrary(db, libraryId);
    if (!library) return reply.code(404).send({ error: { code: "library_not_found", message: "媒体库不存在" } });
    const items = buildPlan(db, libraryId, pattern || DEFAULT_RENAME_PATTERN, limit);
    return {
      pattern,
      writebackEnabled,
      enabled: writebackEnabled && getSettingBoolean(db, "organize.enabled", false),
      library: { id: library.id, rootPath: library.root_path },
      items,
      conflictCount: items.filter((item) => item.conflict !== null).length,
    };
  });

  app.post("/api/organize/apply", async (request, reply) => {
    if (!writebackEnabled) {
      return reply
        .code(409)
        .send({ error: { code: "writeback_disabled", message: "需要容器以 DATA_MODE=writeback 启动" } });
    }
    if (!getSettingBoolean(db, "organize.enabled", false)) {
      return reply.code(409).send({ error: { code: "organize_disabled", message: "整理未在设置页开启" } });
    }
    const body = (request.body ?? {}) as { libraryId?: unknown; workIds?: unknown; confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({ error: { code: "confirm_required", message: "需要 confirm=true 才执行写操作" } });
    }
    const libraryId = Number(body.libraryId ?? 0);
    const library = findLibrary(db, libraryId);
    if (!library) return reply.code(404).send({ error: { code: "library_not_found", message: "媒体库不存在" } });
    const pattern = getSetting(db, "organize.pattern") ?? DEFAULT_RENAME_PATTERN;
    const requested = Array.isArray(body.workIds) ? new Set(body.workIds.map(Number)) : null;
    const plan = buildPlan(db, libraryId, pattern, 200).filter(
      (item) => (!requested || requested.has(item.workId)) && item.conflict === null,
    );
    const journal: Array<{ workId: number; from: string; to: string; ok: boolean; error?: string }> = [];
    let applied = 0;
    for (const item of plan) {
      if (!insideRoot(library.root_path, item.to)) {
        journal.push({ workId: item.workId, from: item.from, to: item.to, ok: false, error: "outside_root" });
        continue;
      }
      try {
        await access(item.from);
        const targetExists = await stat(item.to).then(
          () => true,
          () => false,
        );
        if (targetExists) {
          journal.push({ workId: item.workId, from: item.from, to: item.to, ok: false, error: "target_exists" });
          continue;
        }
        await mkdir(dirname(item.to), { recursive: true });
        await rename(item.from, item.to);
        applied += 1;
        journal.push({ workId: item.workId, from: item.from, to: item.to, ok: true });
      } catch (error) {
        journal.push({
          workId: item.workId,
          from: item.from,
          to: item.to,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const journalId = `organize-${Date.now()}`;
    const entry: JournalEntry = {
      type: "organize",
      at: new Date().toISOString(),
      pattern,
      items: journal,
    };
    const journalPath = await writeJournal(config.configDir, journalId, entry);
    return {
      applied,
      failed: journal.length - applied,
      journalId,
      journalPath,
      rescanRequired: applied > 0,
    };
  });

  app.get("/api/organize/journal", async () => {
    return { entries: await listJournal(config.configDir, 50) };
  });

  app.post("/api/organize/undo/:id", async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? "");
    if (!/^[a-z]+-\d+$/.test(id)) {
      return reply.code(400).send({ error: { code: "invalid_id", message: "journal id 格式不正确" } });
    }
    try {
      const result = await undoJournal(config.configDir, db, id);
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ error: { code: "journal_not_found", message: `无法撤销：${message}` } });
    }
  });

  // NFO 写回：三重门禁 = DATA_MODE=writeback + 设置页 NFO 开关 + confirm。
  app.post("/api/works/:id/nfo", async (request, reply) => {
    if (!writebackEnabled) {
      return reply
        .code(409)
        .send({ error: { code: "writeback_disabled", message: "需要容器以 DATA_MODE=writeback 启动" } });
    }
    const body = (request.body ?? {}) as { confirm?: unknown; force?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({ error: { code: "confirm_required", message: "需要 confirm=true 才执行写操作" } });
    }
    if (!getSettingBoolean(db, "organize.enabled", false) || !getSettingBoolean(db, "organize.nfo", false)) {
      return reply
        .code(409)
        .send({ error: { code: "organize_disabled", message: "NFO 写回未在设置页开启" } });
    }
    const workId = Number((request.params as { id?: string }).id);
    const row = findWork(db, workId);
    if (!row) return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    const library = findLibrary(db, row.library_id);
    if (!library) return reply.code(404).send({ error: { code: "library_not_found", message: "媒体库不存在" } });
    const workDir = join(library.root_path, row.path);
    if (!insideRoot(library.root_path, workDir)) {
      return reply.code(400).send({ error: { code: "invalid_path", message: "作品路径越出媒体库根目录" } });
    }
    const tags = listWorkTags(db, workId).map((tag) => `${tag.namespace}:${tag.name}`);
    const content = buildNfo({
      id: row.id,
      title: row.title,
      kind: row.kind,
      pageCount: row.page_count,
      gid: row.gid,
      rating: row.rating ?? null,
      tags,
    });
    const filename = nfoFileName({ title: row.title });
    const target = join(workDir, filename);
    if ((await stat(target).then(() => true, () => false)) && body.force !== true) {
      return reply
        .code(409)
        .send({ error: { code: "target_exists", message: "同名 NFO 已存在；如需覆盖请带 force=true" } });
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    const journalId = `nfo-${Date.now()}`;
    const journalPath = await writeJournal(config.configDir, journalId, {
      type: "nfo",
      at: new Date().toISOString(),
      files: [target],
      workIds: [workId],
    });
    return { ok: true, path: target, filename, journalId, journalPath };
  });

  // 重复合并写回：只改索引（隐藏副本 + 记录 merged_into），源文件不动，可撤销。
  app.post("/api/works/merge", async (request, reply) => {
    const body = (request.body ?? {}) as { keepId?: unknown; confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({ error: { code: "confirm_required", message: "需要 confirm=true 才执行合并" } });
    }
    const keepId = Number(body.keepId ?? 0);
    const keep = findWork(db, keepId);
    if (!keep) return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    if (!keep.dup_key) {
      return reply.code(409).send({ error: { code: "not_duplicate", message: "该作品没有疑似重复条目" } });
    }
    const rows = db
      .prepare("SELECT * FROM works WHERE dup_key = ? AND hidden = 0")
      .all(keep.dup_key) as unknown as WorkRow[];
    const dropIds = rows.map((row) => row.id).filter((id) => id !== keepId);
    const { merged } = mergeWorks(db, keepId, dropIds);
    const journalId = `merge-${Date.now()}`;
    const journalPath = await writeJournal(config.configDir, journalId, {
      type: "merge",
      at: new Date().toISOString(),
      keepId,
      dropIds,
    });
    return { ok: true, keepId, merged, dropIds, journalId, journalPath, rescanRequired: false };
  });

  app.get("/api/works/:id/nfo", async (request, reply) => {
    const workId = Number((request.params as { id?: string }).id);
    const row = db.prepare("SELECT * FROM works WHERE id = ?").get(workId) as WorkRow | undefined;
    if (!row) return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    const tags = listWorkTags(db, workId).map((tag) => `${tag.namespace}:${tag.name}`);
    const content = buildNfo({
      id: row.id,
      title: row.title,
      kind: row.kind,
      pageCount: row.page_count,
      gid: row.gid,
      rating: row.rating ?? null,
      tags,
    });
    const filename = nfoFileName({ title: row.title });
    const targetPath = join(dirname(row.path), filename);
    return {
      filename,
      content,
      // 预览接口不写盘；写回由 apply 或未来的 NFO 写回流程负责。
      writePath: getSettingBoolean(db, "organize.nfo", false) ? targetPath : null,
      writebackEnabled,
    };
  });

  app.get("/api/duplicates", async () => {
    // 只把「归一化标题相同 + 页数相同」的作品归为一组；
    // 同作者的 notext 系列页数各不相同，不会被误判为重复。
    const rows = db
      .prepare(
        "SELECT dup_key AS key, page_count, COUNT(*) AS count FROM works " +
          "WHERE dup_key IS NOT NULL AND dup_key <> '' " +
          "GROUP BY dup_key, page_count HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT 50",
      )
      .all() as Array<{ key: string; page_count: number; count: number }>;
    const groups = rows.map((group) => ({
      key: group.key,
      pageCount: group.page_count,
      count: group.count,
      works: (db
        .prepare("SELECT id, title, path, page_count FROM works WHERE dup_key = ? AND page_count = ?")
        .all(group.key, group.page_count) as Array<{
        id: number;
        title: string;
        path: string;
        page_count: number;
      }>).map((work) => ({ id: work.id, title: work.title, path: work.path, pageCount: work.page_count })),
    }));
    return { groups };
  });

  app.post("/api/duplicates/preview-merge", async (request, reply) => {
    const body = (request.body ?? {}) as { keepId?: unknown };
    const keepId = Number(body.keepId ?? 0);
    const keep = db.prepare("SELECT * FROM works WHERE id = ?").get(keepId) as WorkRow | undefined;
    if (!keep) return reply.code(404).send({ error: { code: "not_found", message: "作品不存在" } });
    if (!keep.dup_key) {
      return reply.code(409).send({ error: { code: "not_duplicate", message: "该作品没有疑似重复条目" } });
    }
    const rows = db
      .prepare("SELECT * FROM works WHERE dup_key = ? AND page_count = ?")
      .all(keep.dup_key, keep.page_count) as unknown as WorkRow[];
    if (rows.length < 2) {
      return reply.code(409).send({ error: { code: "not_duplicate", message: "没有找到同页数的疑似重复条目" } });
    }
    const works = rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      pageCount: row.page_count,
      tags: listWorkTags(db, row.id).map((tag) => `${tag.namespace}:${tag.name}`),
    }));
    return { plan: planMerge(works, keepId), writebackEnabled };
  });
}

