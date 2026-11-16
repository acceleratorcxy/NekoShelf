import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL_V1, DDL_V2, DDL_V3, DDL_V4, DDL_V5, SCHEMA_VERSION } from "./schema.js";

export type Db = DatabaseSync;

export interface OpenOptions {
  /** `:memory:` 用于测试。 */
  path: string;
}

/**
 * 打开数据库并迁移到最新版本。
 *
 * 硬约束：库文件必须位于本地卷（/config）。传入网络路径（SMB/NFS）时直接抛错，
 * 由调用方转成启动失败——这是刻意为之，不是 bug。
 */
export function openDatabase(options: OpenOptions): Db {
  const isMemory = options.path === ":memory:";
  if (!isMemory) {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (version >= SCHEMA_VERSION) return;

  db.exec("BEGIN");
  try {
    if (version < 1) db.exec(DDL_V1);
    if (version < 2) db.exec(DDL_V2);
    if (version < 3) db.exec(DDL_V3);
    if (version < 4) db.exec(DDL_V4);
    if (version < 5) db.exec(DDL_V5);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
