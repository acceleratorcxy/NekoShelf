import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./database.js";
import { nowIso } from "./database.js";
import {
  needsProgressJoin,
  parseSearchQuery,
  searchFiltersToSql,
} from "../query.js";
import type {
  JobRow,
  WorkChapter,
  LibraryKind,
  LibraryRow,
  PageRow,
  ProgressRow,
  Role,
  TagRow,
  UserRow,
  WorkKind,
  WorkQuery,
  WorkRow,
} from "./types.js";

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/* ---------------------------------- users --------------------------------- */

export function countUsers(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
}

export function createUser(
  db: Db,
  input: { username: string; passwordHash: string; role?: Role },
): UserRow {
  const at = nowIso();
  const result = db
    .prepare(
      "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.username, input.passwordHash, input.role ?? "admin", at, at);
  return findUserById(db, Number(result.lastInsertRowid))!;
}

export function findUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | UserRow
    | undefined;
}

export function listUsers(db: Db): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[];
}

/* --------------------------------- sessions -------------------------------- */

export function createSession(
  db: Db,
  input: { userId: number; ttlMs: number; userAgent?: string; ip?: string },
): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.userId,
    new Date(now).toISOString(),
    new Date(now + input.ttlMs).toISOString(),
    input.userAgent ?? null,
    input.ip ?? null,
  );
  return id;
}

export function getSessionUser(db: Db, sessionId: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, nowIso()) as UserRow | undefined;
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function deleteSessionsForUser(db: Db, userId: number): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function sweepExpiredSessions(db: Db): number {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso()).changes);
}

/* -------------------------------- libraries -------------------------------- */

export function createLibrary(
  db: Db,
  input: { name: string; rootPath: string; kind?: LibraryKind },
): LibraryRow {
  const result = db
    .prepare("INSERT INTO libraries (name, root_path, kind, created_at) VALUES (?, ?, ?, ?)")
    .run(input.name, input.rootPath, input.kind ?? "mixed", nowIso());
  return findLibrary(db, Number(result.lastInsertRowid))!;
}

export function findLibrary(db: Db, id: number): LibraryRow | undefined {
  return db.prepare("SELECT * FROM libraries WHERE id = ?").get(id) as LibraryRow | undefined;
}

export function findLibraryByPath(db: Db, rootPath: string): LibraryRow | undefined {
  return db.prepare("SELECT * FROM libraries WHERE root_path = ?").get(rootPath) as
    | LibraryRow
    | undefined;
}

export function listLibraries(db: Db): LibraryRow[] {
  return db.prepare("SELECT * FROM libraries ORDER BY id").all() as unknown as LibraryRow[];
}

export function deleteLibrary(db: Db, id: number): void {
  db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
}

export function touchLibraryScan(db: Db, id: number): void {
  db.prepare("UPDATE libraries SET last_scan_at = ? WHERE id = ?").run(nowIso(), id);
}

export function countWorksInLibrary(db: Db, libraryId: number): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS n FROM works WHERE library_id = ?").get(libraryId) as {
      n: number;
    }).n,
  );
}

/* ---------------------------------- works ---------------------------------- */

export interface UpsertWorkInput {
  libraryId: number;
  /** 相对库根目录的路径（使用 `/` 分隔）。 */
  relativePath: string;
  title: string;
  kind: WorkKind;
  sourceKind: WorkRow["source_kind"];
  gid?: number | null;
  pageCount: number;
  rating?: number | null;
  mtime?: number | null;
  sizeBytes?: number | null;
  fingerprint?: string | null;
  /** 目录内存在 ComicInfo.xml（刮削时跳过） */
  hasComicInfo?: boolean;
  /** 标题归一化键；不传则按 title 自动生成。 */
  dupKey?: string | null;
  pages?: Array<{
    name: string;
    subpath?: string | null;
    sizeBytes?: number | null;
    lang?: string | null;
    pairKey?: string | null;
  }>;
}

export function upsertWork(
  db: Db,
  input: UpsertWorkInput,
): { id: number; action: "created" | "updated" | "unchanged" } {
  const pathHash = stableHash(input.relativePath);
  const dupKey = (input.dupKey ?? normalizeTitleKey(input.title)) || null;
  const existing = db
    .prepare("SELECT * FROM works WHERE library_id = ? AND path_hash = ?")
    .get(input.libraryId, pathHash) as WorkRow | undefined;

  if (existing) {
    const changed =
      existing.mtime !== (input.mtime ?? null) ||
      existing.size_bytes !== (input.sizeBytes ?? null) ||
      existing.title !== input.title ||
      existing.page_count !== input.pageCount ||
      existing.kind !== input.kind ||
      existing.gid !== (input.gid ?? null) ||
      (existing.dup_key ?? null) !== dupKey ||
      (input.hasComicInfo !== undefined &&
        existing.has_comicinfo !== (input.hasComicInfo ? 1 : 0));
    if (!changed) return { id: existing.id, action: "unchanged" };

    db.prepare(
      `UPDATE works SET title = ?, kind = ?, source_kind = ?, gid = ?, page_count = ?,
         rating = ?, mtime = ?, size_bytes = ?, fingerprint = ?, has_comicinfo = ?,
         dup_key = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title,
      input.kind,
      input.sourceKind,
      input.gid ?? null,
      input.pageCount,
      input.rating ?? existing.rating ?? null,
      input.mtime ?? null,
      input.sizeBytes ?? null,
      input.fingerprint ?? existing.fingerprint ?? null,
      input.hasComicInfo !== undefined ? (input.hasComicInfo ? 1 : 0) : existing.has_comicinfo,
      dupKey,
      nowIso(),
      existing.id,
    );
    if (input.pages) replacePages(db, existing.id, input.pages);
    return { id: existing.id, action: "updated" };
  }

  const at = nowIso();
  const result = db
    .prepare(
      `INSERT INTO works (library_id, path, path_hash, title, kind, source_kind, gid,
         page_count, rating, mtime, size_bytes, fingerprint, has_comicinfo, dup_key,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.libraryId,
      input.relativePath,
      pathHash,
      input.title,
      input.kind,
      input.sourceKind,
      input.gid ?? null,
      input.pageCount,
      input.rating ?? null,
      input.mtime ?? null,
      input.sizeBytes ?? null,
      input.fingerprint ?? null,
      input.hasComicInfo ? 1 : 0,
      dupKey,
      at,
      at,
    );
  const id = Number(result.lastInsertRowid);
  if (input.pages) replacePages(db, id, input.pages);
  return { id, action: "created" };
}

export function replacePages(
  db: Db,
  workId: number,
  pages: Array<{
    name: string;
    subpath?: string | null;
    sizeBytes?: number | null;
    lang?: string | null;
    pairKey?: string | null;
  }>,
): void {
  db.prepare("DELETE FROM pages WHERE work_id = ?").run(workId);
  const insert = db.prepare(
    `INSERT INTO pages (work_id, ordinal, name, subpath, size_bytes, lang, pair_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  pages.forEach((page, index) => {
    insert.run(
      workId,
      index + 1,
      page.name,
      page.subpath ?? null,
      page.sizeBytes ?? null,
      page.lang ?? null,
      page.pairKey ?? null,
    );
  });
}

export function replaceWorkChapters(
  db: Db,
  workId: number,
  chapters: Array<{ title: string; relPath: string; startPage: number; pageCount: number }>,
): void {
  db.prepare("DELETE FROM work_chapters WHERE work_id = ?").run(workId);
  const insert = db.prepare(
    `INSERT INTO work_chapters (work_id, title, rel_path, start_page, page_count, sort)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  chapters.forEach((chapter, index) => {
    insert.run(workId, chapter.title, chapter.relPath, chapter.startPage, chapter.pageCount, index);
  });
}

export function listWorkChapters(db: Db, workId: number): WorkChapter[] {
  return db
    .prepare("SELECT * FROM work_chapters WHERE work_id = ? ORDER BY sort")
    .all(workId) as unknown as WorkChapter[];
}

/** 用于「同作者 + 相似标题」的系列归并：取没有系列归属的作品与其作者。 */
export function listWorksNeedingSeries(
  db: Db,
  libraryId: number,
): Array<{ id: number; title: string; authors: string[] }> {
  const rows = db
    .prepare(
      `SELECT w.id, w.title, p.name AS person
         FROM works w
         LEFT JOIN work_people wp ON wp.work_id = w.id
         LEFT JOIN people p ON p.id = wp.person_id
        WHERE w.library_id = ? AND w.series_id IS NULL AND w.hidden = 0
        ORDER BY w.id`,
    )
    .all(libraryId) as unknown as Array<{ id: number; title: string; person: string | null }>;
  const map = new Map<number, { id: number; title: string; authors: string[] }>();
  for (const row of rows) {
    const entry = map.get(row.id) ?? { id: row.id, title: row.title, authors: [] };
    if (row.person) entry.authors.push(row.person);
    map.set(row.id, entry);
  }
  return [...map.values()];
}

export function findWork(db: Db, id: number): WorkRow | undefined {
  return db.prepare("SELECT * FROM works WHERE id = ?").get(id) as WorkRow | undefined;
}

export function listWorkPages(db: Db, workId: number): PageRow[] {
  return db
    .prepare("SELECT * FROM pages WHERE work_id = ? ORDER BY ordinal")
    .all(workId) as unknown as PageRow[];
}

export interface WorkListResult {
  items: WorkRow[];
  total: number;
}

export function listWorks(db: Db, query: WorkQuery = {}): WorkListResult {
  const pageSize = Math.min(Math.max(query.pageSize ?? 48, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const offset = (page - 1) * pageSize;
  const where: string[] = ["w.hidden = 0"];
  const params: Array<string | number> = [];

  if (query.libraryId !== undefined) {
    where.push("w.library_id = ?");
    params.push(query.libraryId);
  }
  if (query.kind) {
    where.push("w.kind = ?");
    params.push(query.kind);
  }
  if (query.personId !== undefined) {
    where.push("EXISTS (SELECT 1 FROM work_people wp WHERE wp.work_id = w.id AND wp.person_id = ?)");
    params.push(query.personId);
  }
  if (query.seriesId !== undefined) {
    where.push("w.series_id = ?");
    params.push(query.seriesId);
  }

  // `q` 支持标签/页数/进度/排除/通配等查询语法（packages/core/src/query.ts）
  const filters = parseSearchQuery(query.q);
  const fragment = searchFiltersToSql(filters);
  where.push(...fragment.where);
  params.push(...fragment.params);
  const progressJoin = needsProgressJoin(filters)
    ? "LEFT JOIN progress p ON p.work_id = w.id"
    : "";

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order =
    query.sort === "title"
      ? "ORDER BY w.title COLLATE NOCASE ASC"
      : query.sort === "rating"
        ? "ORDER BY COALESCE(w.rating, -1) DESC, w.updated_at DESC"
        : "ORDER BY w.updated_at DESC, w.id DESC";

  const total = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM works w ${progressJoin} ${whereSql}`)
        .get(...params) as { n: number }
    ).n,
  );
  const items = db
    .prepare(`SELECT w.* FROM works w ${progressJoin} ${whereSql} ${order} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as unknown as WorkRow[];

  return { items, total };
}

/** FTS5 MATCH 语法：按空白切词，全部加引号避免用户输入触发语法错误。 */
export function toFtsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, "").trim())
    .filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((term) => `"${term}"*`).join(" AND ");
}

/* --------------------------------- progress -------------------------------- */

export function getProgress(db: Db, workId: number): ProgressRow | undefined {
  return db.prepare("SELECT * FROM progress WHERE work_id = ?").get(workId) as
    | ProgressRow
    | undefined;
}

export function setProgress(db: Db, workId: number, page: number, pageCount: number): void {
  db.prepare(
    `INSERT INTO progress (work_id, page, page_count, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(work_id) DO UPDATE SET page = excluded.page, page_count = excluded.page_count,
       updated_at = excluded.updated_at`,
  ).run(workId, page, pageCount, nowIso());
}

/* ----------------------------------- tags ---------------------------------- */

export function ensureTag(db: Db, namespace: string, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (namespace, name) VALUES (?, ?)").run(namespace, name);
  return Number(
    (db.prepare("SELECT id FROM tags WHERE namespace = ? AND name = ?").get(namespace, name) as {
      id: number;
    }).id,
  );
}

/** 按 namespace 覆盖某作品的标签（其它 namespace 的标签保持不动，例如刮削结果）。 */
export function setWorkTagsByNamespace(
  db: Db,
  workId: number,
  namespace: string,
  names: string[],
): void {
  db.prepare(
    `DELETE FROM work_tags WHERE work_id = ?
       AND tag_id IN (SELECT id FROM tags WHERE namespace = ?)`,
  ).run(workId, namespace);
  const link = db.prepare("INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)");
  for (const name of names) link.run(workId, ensureTag(db, namespace, name));
}

export function setWorkTags(db: Db, workId: number, tags: Array<{ namespace: string; name: string }>): void {
  db.prepare("DELETE FROM work_tags WHERE work_id = ?").run(workId);
  const link = db.prepare("INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)");
  for (const tag of tags) {
    link.run(workId, ensureTag(db, tag.namespace, tag.name));
  }
}

export function listWorkTags(db: Db, workId: number): TagRow[] {
  return db
    .prepare(
      `SELECT t.* FROM tags t JOIN work_tags wt ON wt.tag_id = t.id
        WHERE wt.work_id = ? ORDER BY t.namespace, t.name`,
    )
    .all(workId) as unknown as TagRow[];
}

export function listTags(db: Db, q?: string, limit = 20): Array<TagRow & { count: number }> {
  const pattern = q ? `%${q}%` : null;
  return db
    .prepare(
      `SELECT t.*, COUNT(wt.work_id) AS count FROM tags t
         LEFT JOIN work_tags wt ON wt.tag_id = t.id
        WHERE (? IS NULL OR t.name LIKE ?)
        GROUP BY t.id ORDER BY count DESC, t.name LIMIT ?`,
    )
    .all(pattern, pattern, limit) as unknown as Array<TagRow & { count: number }>;
}

/* ----------------------------------- jobs ---------------------------------- */

export function createJob(
  db: Db,
  input: { id: string; type: string; libraryId?: number | null; payload?: unknown },
): JobRow {
  db.prepare(
    "INSERT INTO jobs (id, type, state, library_id, payload, created_at) VALUES (?, ?, 'queued', ?, ?, ?)",
  ).run(
    input.id,
    input.type,
    input.libraryId ?? null,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    nowIso(),
  );
  return findJob(db, input.id)!;
}

export function findJob(db: Db, id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listJobs(db: Db, limit = 50): JobRow[] {
  return db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as JobRow[];
}

export function updateJob(
  db: Db,
  id: string,
  patch: {
    state?: JobRow["state"];
    progress?: { done: number; total: number };
    message?: string | null;
  },
): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.state) {
    sets.push("state = ?");
    params.push(patch.state);
    if (patch.state === "running") sets.push("started_at = COALESCE(started_at, ?)");
    if (patch.state === "running") params.push(nowIso());
    if (patch.state === "done" || patch.state === "failed" || patch.state === "cancelled") {
      sets.push("finished_at = ?");
      params.push(nowIso());
    }
  }
  if (patch.progress) {
    sets.push("progress = ?");
    params.push(JSON.stringify(patch.progress));
  }
  if (patch.message !== undefined) {
    sets.push("message = ?");
    params.push(patch.message);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function appendJobLog(db: Db, jobId: string, message: string, level = "info"): void {
  db.prepare("INSERT INTO job_logs (job_id, level, message, at) VALUES (?, ?, ?, ?)").run(
    jobId,
    level,
    message,
    nowIso(),
  );
}

/* ---------------------------------- misc ----------------------------------- */

export function addSkipRecord(db: Db, libraryId: number, path: string, reason: string): void {
  db.prepare("INSERT INTO skip_records (library_id, path, reason, at) VALUES (?, ?, ?, ?)").run(
    libraryId,
    path,
    reason,
    nowIso(),
  );
}

export function listSkipRecords(db: Db, libraryId: number, limit = 100): Array<{ path: string; reason: string; at: string }> {
  return db
    .prepare("SELECT path, reason, at FROM skip_records WHERE library_id = ? ORDER BY id DESC LIMIT ?")
    .all(libraryId, limit) as unknown as Array<{ path: string; reason: string; at: string }>;
}

export function addAuditLog(
  db: Db,
  input: { actor?: string | null; action: string; target?: string | null; detail?: unknown },
): void {
  db.prepare("INSERT INTO audit_logs (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(
    nowIso(),
    input.actor ?? null,
    input.action,
    input.target ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  );
}

export function workTagsFor(db: Db, workIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (workIds.length === 0) return map;
  const placeholders = workIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT wt.work_id, t.namespace, t.name FROM work_tags wt JOIN tags t ON t.id = wt.tag_id
        WHERE wt.work_id IN (${placeholders})`,
    )
    .all(...workIds) as unknown as Array<{ work_id: number; namespace: string; name: string }>;
  for (const row of rows) {
    const label = row.namespace ? `${row.namespace}:${row.name}` : row.name;
    const list = map.get(row.work_id) ?? [];
    list.push(label);
    map.set(row.work_id, list);
  }
  return map;
}

/* ── 应用设置（刮削开关、节奏； ─────────────────────── */

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getSettingBoolean(db: Db, key: string, fallback = false): boolean {
  const value = getSetting(db, key);
  if (value === null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function listSettings(db: Db): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as unknown as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/* ── 刮削源凭据（payload 为 AES-256-GCM 密文，见 server/crypto.ts） ── */

export function upsertSourceCredential(db: Db, source: string, encryptedPayload: string): void {
  db.prepare(
    `INSERT INTO source_credentials (source, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(source, encryptedPayload, nowIso());
}

export function findSourceCredential(
  db: Db,
  source: string,
): { payload: string; updated_at: string } | null {
  const row = db
    .prepare("SELECT payload, updated_at FROM source_credentials WHERE source = ?")
    .get(source) as unknown as { payload: string; updated_at: string } | undefined;
  return row ?? null;
}

export function deleteSourceCredential(db: Db, source: string): void {
  db.prepare("DELETE FROM source_credentials WHERE source = ?").run(source);
}

/* ── 刮削缓存（同 key 默认 7 天过期） ─────────────── */

export function writeScrapeCache(db: Db, key: string, payload: unknown, ttlDays = 7): void {
  const fetchedAt = nowIso();
  const expiresAt = new Date(Date.parse(fetchedAt) + ttlDays * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO scrape_cache (key, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
  ).run(key, JSON.stringify(payload), fetchedAt, expiresAt);
}

export function readScrapeCache<T>(db: Db, key: string, now = new Date()): T | null {
  const row = db
    .prepare("SELECT payload, expires_at FROM scrape_cache WHERE key = ?")
    .get(key) as unknown as { payload: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now.getTime()) return null;
  return JSON.parse(row.payload) as T;
}

/* ── 刮削候选：有 gid、默认跳过已有元数据（ComicInfo/已有标签） ── */

export interface ScrapeCandidateQuery {
  libraryId?: number;
  /** 手动重刮：忽略「已有元数据」保护。 */
  force?: boolean;
  limit?: number;
}

export function listScrapeCandidates(db: Db, query: ScrapeCandidateQuery = {}): WorkRow[] {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
  const libraryId = query.libraryId ?? null;
  return db
    .prepare(
      `SELECT w.* FROM works w
        WHERE w.gid IS NOT NULL
          AND w.kind = 'comic'
          AND (? IS NULL OR w.library_id = ?)
          AND (? = 1 OR (w.has_comicinfo = 0
                AND NOT EXISTS (SELECT 1 FROM work_tags wt WHERE wt.work_id = w.id)))
        ORDER BY w.id ASC LIMIT ?`,
    )
    .all(libraryId, libraryId, query.force ? 1 : 0, limit) as unknown as WorkRow[];
}

/** 刮削回写：标题/页数/元数据标记（不改路径与文件）。 */
export function updateWorkMetadata(
  db: Db,
  workId: number,
  patch: { title?: string; pageCount?: number; hasComicInfo?: boolean },
): void {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
    sets.push("dup_key = ?");
    values.push(normalizeTitleKey(patch.title));
  }
  if (patch.pageCount !== undefined) {
    sets.push("page_count = ?");
    values.push(patch.pageCount);
  }
  if (patch.hasComicInfo !== undefined) {
    sets.push("has_comicinfo = ?");
    values.push(patch.hasComicInfo ? 1 : 0);
  }
  if (sets.length === 0) return;
  values.push(nowIso(), workId);
  db.prepare(`UPDATE works SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values);
}

/* --------------------------- 重复提示与双语页 --------------------------- */

/**
 * 标题归一化：去掉括号注释（[汉化组]/【...】/(C92)）与标点空白，只留字母数字与 CJK。
 * 仅用于「疑似重复」提示，不自动合并（需人工确认）。
 */
/** 无信息量的占位标题：不能作为重复判定依据（同作者不同系列常都叫 notext）。 */
const PLACEHOLDER_TITLES = new Set([
  "notext",
  "notetitle",
  "untitled",
  "untitle",
  "notitle",
  "no title",
  "cover",
  "index",
  "image",
  "img",
  "sample",
  "preview",
  "无题",
  "无标题",
  "未命名",
]);

export function normalizeTitleKey(title: string): string {
  const key = title
    .replace(/[\[【（(][^\]】）)]*[\]】）)]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
  if (key.length < 2) return "";
  if (PLACEHOLDER_TITLES.has(key)) return "";
  if (/^(img|image|dsc|dscf|photo|pic|图片|照片)\d*$/.test(key)) return "";
  return key;
}

export type DuplicateReason = "gid" | "exact" | "title";

export interface DuplicateCandidate {
  id: number;
  title: string;
  path: string;
  kind: WorkKind;
  pageCount: number;
  reason: DuplicateReason;
}

/**
 * 找同库内的疑似重复作品。判定从严，避免「同作者不同系列」被误判：
 * 1. E-H 画廊号相同（gid）——最可靠；
 * 2. 体积与页数完全一致；
 * 3. 标题归一化相同「且」页数相同（同标题不同页数通常是不同作品）。
 */
export function findDuplicateCandidates(db: Db, work: WorkRow): DuplicateCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, title, path, kind, page_count, gid,
              (gid IS NOT NULL AND gid <> 0 AND gid = ?) AS same_gid,
              (size_bytes IS NOT NULL AND size_bytes = ? AND page_count = ? AND page_count > 1) AS exact,
              (dup_key IS NOT NULL AND dup_key <> '' AND dup_key = ? AND page_count = ?) AS same_title
         FROM works
        WHERE library_id = ? AND id <> ?
          AND ((gid IS NOT NULL AND gid <> 0 AND gid = ?)
               OR (page_count > 1 AND size_bytes IS NOT NULL AND size_bytes = ? AND page_count = ?)
               OR (dup_key IS NOT NULL AND dup_key <> '' AND dup_key = ? AND page_count = ?))
        LIMIT 20`,
    )
    .all(
      work.gid,
      work.size_bytes,
      work.page_count,
      work.dup_key ?? "",
      work.page_count,
      work.library_id,
      work.id,
      work.gid,
      work.size_bytes,
      work.page_count,
      work.dup_key ?? "",
      work.page_count,
    ) as Array<{
    id: number;
    title: string;
    path: string;
    kind: WorkKind;
    page_count: number;
    same_gid: number;
    exact: number;
    same_title: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    path: row.path,
    kind: row.kind,
    pageCount: row.page_count,
    reason: row.same_gid === 1 ? "gid" : row.exact === 1 ? "exact" : "title",
  }));
}

/** 同配对键的指定语言页（双语对照阅读用）；找不到返回 undefined。 */
export function findLanguageVariant(
  db: Db,
  workId: number,
  page: PageRow,
  lang: string,
): PageRow | undefined {
  if (!page.pair_key) return undefined;
  return db
    .prepare(
      `SELECT * FROM pages WHERE work_id = ? AND pair_key = ? AND lang LIKE ? AND id <> ?
        ORDER BY ordinal LIMIT 1`,
    )
    .get(workId, page.pair_key, `${lang}%`, page.id) as PageRow | undefined;
}

/** 每页的对照页信息（给详情接口，前端据此显示「原版/汉化/对照」）。 */
export interface PagePairLink {
  ordinal: number;
  lang: string | null;
  pairKey: string | null;
  /** 另一个语言版本的页码；无则为 null。 */
  variantOf: number | null;
}

export function listPagePairLinks(db: Db, workId: number): PagePairLink[] {
  const pages = listWorkPages(db, workId);
  return pages.map((page) => {
    let variantOf: number | null = null;
    if (page.pair_key) {
      const counterpart = pages.find(
        (other) => other.id !== page.id && other.pair_key === page.pair_key,
      );
      variantOf = counterpart ? counterpart.ordinal : null;
    }
    return {
      ordinal: page.ordinal,
      lang: page.lang ?? null,
      pairKey: page.pair_key ?? null,
      variantOf,
    };
  });
}

/**
 * 合并写回：保留 keepId，其余副本标记 hidden + merged_into。
 * 不移动/删除任何源文件；撤销用 unmergeWorks 清空标记即可。
 */
export function mergeWorks(db: Db, keepId: number, dropIds: number[]): { merged: number } {
  const drops = dropIds.filter((id) => id !== keepId);
  if (drops.length === 0) return { merged: 0 };
  const now = nowIso();
  db.exec("BEGIN");
  try {
    for (const id of drops) {
      db.prepare(
        "UPDATE works SET hidden = 1, merged_into = ?, updated_at = ? WHERE id = ?",
      ).run(keepId, now, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.prepare("UPDATE works SET updated_at = ? WHERE id = ?").run(now, keepId);
  return { merged: drops.length };
}

/** 撤销合并：清空 hidden / merged_into。 */
export function unmergeWorks(db: Db, dropIds: number[]): { restored: number } {
  if (dropIds.length === 0) return { restored: 0 };
  const now = nowIso();
  let restored = 0;
  db.exec("BEGIN");
  try {
    for (const id of dropIds) {
      const result = db
        .prepare("UPDATE works SET hidden = 0, merged_into = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
      restored += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { restored };
}

/** 被合并进该作品的副本（详情页展示「已合并 N 份」用）。 */
export function listMergedInto(db: Db, keepId: number): WorkRow[] {
  return db
    .prepare("SELECT * FROM works WHERE merged_into = ? AND hidden = 1 ORDER BY id")
    .all(keepId) as unknown as WorkRow[];
}

/* ------------------------------ people / series ----------------------------- */

export interface PersonSummary {
  id: number;
  name: string;
  count: number;
}

export interface SeriesSummary {
  id: number;
  name: string;
  count: number;
}

export type WorkPersonRole = "artist" | "writer" | "group" | "series";

export interface WorkPerson {
  id: number;
  role: WorkPersonRole;
  name: string;
}

/** 取或建作者/画师（按名字去重）。 */
export function ensurePerson(db: Db, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("作者名不能为空");
  db.prepare("INSERT INTO people (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(trimmed);
  const row = db.prepare("SELECT id FROM people WHERE name = ?").get(trimmed) as
    | { id: number }
    | undefined;
  return Number(row!.id);
}

/** 覆盖写入作品的人员（先清后写，每次扫描结果为准）。 */
export type WorkPersonInput = Pick<WorkPerson, "role" | "name">;

export function setWorkPeople(db: Db, workId: number, people: WorkPersonInput[]): void {
  db.prepare("DELETE FROM work_people WHERE work_id = ?").run(workId);
  const insert = db.prepare(
    "INSERT INTO work_people (work_id, person_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  for (const person of people) {
    insert.run(workId, ensurePerson(db, person.name), person.role);
  }
}

export function listWorkPeople(db: Db, workId: number): WorkPerson[] {
  return db
    .prepare(
      `SELECT p.id AS id, wp.role AS role, p.name AS name
         FROM work_people wp JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = ?
        ORDER BY wp.role, p.name`,
    )
    .all(workId) as unknown as WorkPerson[];
}

export function ensureSeries(db: Db, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("系列名不能为空");
  db.prepare("INSERT INTO series (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(trimmed);
  const row = db.prepare("SELECT id FROM series WHERE name = ?").get(trimmed) as
    | { id: number }
    | undefined;
  return Number(row!.id);
}

export function setWorkSeries(db: Db, workId: number, seriesId: number | null): void {
  db.prepare("UPDATE works SET series_id = ? WHERE id = ?").run(seriesId, workId);
}

/** 修改作品类型（AI 分类/人工纠正用）。 */
export function updateWorkKind(db: Db, workId: number, kind: "comic" | "image-set" | "video"): void {
  db.prepare("UPDATE works SET kind = ?, updated_at = ? WHERE id = ?").run(kind, nowIso(), workId);
}

/** 写入中文标题（NULL 清除）。 */
export function setTitleZh(db: Db, workId: number, titleZh: string | null): void {
  db.prepare("UPDATE works SET title_zh = ?, updated_at = ? WHERE id = ?").run(
    titleZh,
    nowIso(),
    workId,
  );
}

/** 作者/画师/社团列表（按作品数降序）。 */
export function listPeople(db: Db, q = "", limit = 60): PersonSummary[] {
  const like = `%${q.trim()}%`;
  return db
    .prepare(
      `SELECT p.id AS id, p.name AS name, COUNT(wp.work_id) AS count
         FROM people p
         JOIN work_people wp ON wp.person_id = p.id
         JOIN works w ON w.id = wp.work_id AND w.hidden = 0
        WHERE (? = '' OR p.name LIKE ?)
        GROUP BY p.id
        ORDER BY count DESC, p.name
        LIMIT ?`,
    )
    .all(q.trim(), like, limit) as unknown as PersonSummary[];
}

export function findPerson(db: Db, id: number): { id: number; name: string } | undefined {
  return db.prepare("SELECT id, name FROM people WHERE id = ?").get(id) as
    | { id: number; name: string }
    | undefined;
}

export function listSeries(db: Db, q = "", limit = 60): SeriesSummary[] {
  const like = `%${q.trim()}%`;
  return db
    .prepare(
      `SELECT s.id AS id, s.name AS name, COUNT(w.id) AS count
         FROM series s
         JOIN works w ON w.series_id = s.id AND w.hidden = 0
        WHERE (? = '' OR s.name LIKE ?)
        GROUP BY s.id
        ORDER BY count DESC, s.name
        LIMIT ?`,
    )
    .all(q.trim(), like, limit) as unknown as SeriesSummary[];
}

export function findSeries(db: Db, id: number): { id: number; name: string } | undefined {
  return db.prepare("SELECT id, name FROM series WHERE id = ?").get(id) as
    | { id: number; name: string }
    | undefined;
}

/**
 * 关联作品推荐：同系列 > 同作者/画师 > 同标签，按得分排序。
 * 只返回未合并/未隐藏的作品，且排除自身。
 */
export function relatedWorks(db: Db, workId: number, limit = 12): WorkRow[] {
  const work = findWork(db, workId);
  if (!work) return [];
  const rows = db
    .prepare(
      `SELECT w.*,
              (CASE WHEN w.series_id IS NOT NULL AND w.series_id = ? THEN 3 ELSE 0 END)
              + (SELECT COUNT(*) FROM work_people a
                   JOIN work_people b ON b.person_id = a.person_id
                  WHERE a.work_id = w.id AND b.work_id = ?) * 2
              + (SELECT COUNT(*) FROM work_tags a
                   JOIN work_tags b ON b.tag_id = a.tag_id
                  WHERE a.work_id = w.id AND b.work_id = ?) AS score
         FROM works w
        WHERE w.hidden = 0 AND w.id <> ?
        ORDER BY score DESC, w.updated_at DESC
        LIMIT ?`,
    )
    .all(work.series_id ?? -1, workId, workId, workId, limit) as unknown as Array<
    WorkRow & { score: number }
  >;
  return rows.filter((row) => row.score > 0).map(({ score: _score, ...rest }) => rest as WorkRow);
}

export interface RelatedWorkGroups {
  series: WorkRow[];
  authors: WorkRow[];
  tags: WorkRow[];
  /** 相似名称/目录：给没有 E-H 元数据的作品兜底（按标题与最近两级目录名分词）。 */
  name: WorkRow[];
}

/**
 * 相关推荐按「同系列 / 同作者 / 同标签」分组，组内按重叠程度与更新时间排序。
 * 不包含自身与已隐藏作品；每组最多 limit 个。
 */
/** 相关推荐用的停用词：容器目录名、格式词、占位标题，不代表作品特征。 */
const RELATED_STOP_TOKENS = new Set([
  "ehviewers",
  "作者合集",
  "作者",
  "合集",
  "本子",
  "杂",
  "漫画",
  "图集",
  "视频",
  "单行本",
  "同人志",
  "商业志",
  "汉化",
  "中文",
  "chinese",
  "digital",
  "cover",
  "notext",
  "notetitle",
  "untitled",
  "index",
  "img",
  "image",
  "images",
  "page",
  "pages",
  "下载",
  "未分类",
  "其他",
  "unknown",
]);

/** 把一段文本切成用于相似度比较的词（字母数字片段 + CJK 连续段）。 */
function similarityTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/gu)) {
    if (part.length >= 2 && !RELATED_STOP_TOKENS.has(part)) tokens.push(part);
    // 对「2020theresa2」这类拼写，再拆出字母段与数字段
    for (const sub of part.match(/[a-z]+|\d+/g) ?? []) {
      if (sub.length >= 3 && sub !== part && !RELATED_STOP_TOKENS.has(sub)) tokens.push(sub);
    }
  }
  return tokens;
}

/**
 * 名称/目录相似：同作者合集目录下的不同系列（页数不同、标题可能全是 notext）
 * 也能互相推荐。取标题与最近两级目录名的词，按共享词数排序。
 */
function findSimilarByName(db: Db, work: WorkRow, excluded: Set<number>, limit: number): WorkRow[] {
  const tokensOf = (row: { title: string; path: string }): Set<string> => {
    const segments = row.path.split("/").filter(Boolean);
    const dirs = segments.slice(0, -1).slice(-2);
    const set = new Set<string>(similarityTokens(row.title));
    for (const dir of dirs) for (const token of similarityTokens(dir)) set.add(token);
    return set;
  };

  const target = tokensOf(work);
  if (target.size === 0) return [];

  const candidates = db
    .prepare("SELECT * FROM works WHERE library_id = ? AND hidden = 0 AND id <> ? LIMIT 5000")
    .all(work.library_id, work.id) as unknown as WorkRow[];

  const scored = candidates
    .filter((row) => !excluded.has(row.id))
    .map((row) => {
      const tokens = tokensOf(row);
      let shared = 0;
      for (const token of tokens) if (target.has(token)) shared += 1;
      return { row, shared };
    })
    .filter((item) => item.shared >= 1)
    .sort((a, b) => b.shared - a.shared || b.row.updated_at.localeCompare(a.row.updated_at));

  return scored.slice(0, limit).map((item) => item.row);
}

export function relatedWorkGroups(db: Db, workId: number, limit = 8): RelatedWorkGroups {
  const work = findWork(db, workId);
  if (!work) return { series: [], authors: [], tags: [], name: [] };

  const series = work.series_id
    ? (db
        .prepare("SELECT * FROM works WHERE hidden = 0 AND id <> ? AND series_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(workId, work.series_id, limit) as unknown as WorkRow[])
    : [];

  const authors = db
    .prepare(
      `SELECT w.*, COUNT(DISTINCT wp.person_id) AS overlap
         FROM works w
         JOIN work_people wp ON wp.work_id = w.id
        WHERE w.hidden = 0 AND w.id <> ?
          AND wp.person_id IN (SELECT person_id FROM work_people WHERE work_id = ?)
        GROUP BY w.id
        ORDER BY overlap DESC, w.updated_at DESC
        LIMIT ?`,
    )
    .all(workId, workId, limit) as unknown as Array<WorkRow & { overlap: number }>;

  const tags = db
    .prepare(
      `SELECT w.*, COUNT(DISTINCT wt.tag_id) AS overlap
         FROM works w
         JOIN work_tags wt ON wt.work_id = w.id
        WHERE w.hidden = 0 AND w.id <> ?
          AND wt.tag_id IN (SELECT tag_id FROM work_tags WHERE work_id = ?)
        GROUP BY w.id
        ORDER BY overlap DESC, w.updated_at DESC
        LIMIT ?`,
    )
    .all(workId, workId, limit) as unknown as Array<WorkRow & { overlap: number }>;

  const strip = (rows: Array<WorkRow & { overlap?: number }>): WorkRow[] =>
    rows.map(({ overlap: _o, ...rest }) => rest as WorkRow);

  const authorRows = strip(authors);
  const tagRows = strip(tags);
  const seen = new Set<number>([workId, ...series.map((row) => row.id), ...authorRows.map((row) => row.id), ...tagRows.map((row) => row.id)]);
  const name = findSimilarByName(db, work, seen, limit);

  return { series, authors: authorRows, tags: tagRows, name };
}

/** 某库全部作品（文件树/统计用；作品数上万时建议分页，由调用方控制）。 */
export function listWorksForLibrary(db: Db, libraryId: number): WorkRow[] {
  return db
    .prepare("SELECT * FROM works WHERE library_id = ? AND hidden = 0 ORDER BY path")
    .all(libraryId) as unknown as WorkRow[];
}
