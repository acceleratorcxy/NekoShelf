import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, maintenanceInfo, openDatabase } from "../src/index.js";
import type { Db } from "../src/index.js";

describe("maintenance / 备份", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-backup-"));
    db = openDatabase({ path: join(dir, "nekoshelf.db") });
    db.prepare(
      "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)",
    ).run("admin", "hash", new Date().toISOString(), new Date().toISOString());
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("createBackup 生成一致性快照文件", async () => {
    const backup = await createBackup(db, dir, "0.5.0");
    expect(backup.name).toMatch(/^nekoshelf-.*-0\.5\.0\.db$/);
    expect(backup.bytes).toBeGreaterThan(0);
    const files = await readdir(join(dir, "backups"));
    expect(files).toContain(backup.name);
  });

  it("listBackups 返回按时间倒序的快照", async () => {
    await createBackup(db, dir, "0.5.0");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createBackup(db, dir, "0.5.0");
    const backups = await listBackups(dir);
    expect(backups).toHaveLength(2);
    expect(backups[0]!.createdAt.localeCompare(backups[1]!.createdAt)).toBeGreaterThanOrEqual(0);
  });

  it("快照可被 SQLite 打开且含用户数据", async () => {
    const backup = await createBackup(db, dir, "0.5.0");
    const restored = openDatabase({ path: backup.path });
    try {
      const row = restored.prepare("SELECT username FROM users").get() as { username: string };
      expect(row.username).toBe("admin");
    } finally {
      restored.close();
    }
  });

  it("maintenanceInfo 汇总版本与备份数", async () => {
    await createBackup(db, dir, "0.5.0");
    const info = await maintenanceInfo(db, dir, "0.5.0");
    expect(info.version).toBe("0.5.0");
    expect(info.backups).toHaveLength(1);
  });
});
