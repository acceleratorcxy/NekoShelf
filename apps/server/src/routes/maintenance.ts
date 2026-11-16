import type { FastifyInstance } from "fastify";
import { createBackup, listBackups } from "@nekoshelf/core";
import type { Db } from "@nekoshelf/core";
import type { AppConfig } from "../config.js";

/** 维护：数据库在线快照（VACUUM INTO），只写 CONFIG_DIR/backups，不碰媒体目录。 */
export async function registerMaintenanceRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  app.get("/api/maintenance", async () => {
    const backups = await listBackups(config.configDir);
    return {
      maintenance: {
        version: config.version,
        configDir: config.configDir,
        backupCount: backups.length,
        backups: backups.map((backup) => ({
          name: backup.name,
          bytes: backup.bytes,
          createdAt: backup.createdAt,
        })),
      },
    };
  });

  app.post("/api/maintenance/backup", async () => {
    const backup = await createBackup(db, config.configDir, config.version);
    return { backup: { name: backup.name, bytes: backup.bytes, createdAt: backup.createdAt } };
  });
}
