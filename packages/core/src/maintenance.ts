import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db/database.js";

/** 备份目录（相对 CONFIG_DIR）。 */
export const BACKUP_DIR_NAME = "backups";

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
}

export interface MaintenanceInfo {
  version: string;
  configDir: string;
  backups: BackupInfo[];
}

/**
 * 用 SQLite 的 VACUUM INTO 生成一份一致性快照（在线备份，不锁库、不复制 WAL 中间态）。
 * 只写 CONFIG_DIR/backups，不碰媒体目录。
 */
export async function createBackup(db: Db, configDir: string, version: string): Promise<BackupInfo> {
  const dir = join(configDir, BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const now = new Date();
  // 保留毫秒，保证同一秒内多次备份文件名不冲突。
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "").replace("Z", "");
  const name = `nekoshelf-${stamp}-${version}.db`;
  const path = join(dir, name);
  // VACUUM INTO 的路径是 SQL 字面量，单引号需转义。
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const info = await stat(path);
  return { name, path, bytes: info.size, createdAt: now.toISOString() };
}

/** 列出 CONFIG_DIR/backups 下的快照，按时间倒序（最多 100 条）。 */
export async function listBackups(configDir: string): Promise<BackupInfo[]> {
  const dir = join(configDir, BACKUP_DIR_NAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      out.push({ name, path, bytes: info.size, createdAt: info.mtime.toISOString() });
    } catch {
      // 备份可能刚被外部清理，忽略
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export async function maintenanceInfo(db: Db, configDir: string, version: string): Promise<MaintenanceInfo> {
  const backups = await listBackups(configDir);
  // 触发一次轻量查询以确认 DB 可用（备份/维护页的健康信号）。
  db.prepare("SELECT 1").get();
  return { version, configDir, backups };
}
