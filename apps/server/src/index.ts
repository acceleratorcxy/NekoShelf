import { randomUUID } from "node:crypto";
import { createJob, listLibraries, scanLibrary, updateJob } from "@nekoshelf/core";
import { createApp } from "./app.js";
import { tokenHashFor } from "./auth.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const { app, db } = await createApp(config);

/**
 * 无头部署（无浏览器）时可用 BOOTSTRAP_API_TOKEN 直接注入一个管理员 Token：
 * 明文只从环境变量来，库里只存 `<prefix>:<sha256>`，重复启动不会重复插入。
 */
if (config.bootstrapApiToken) {
  const tokenHash = tokenHashFor(config.bootstrapApiToken);
  const existing = db.prepare("SELECT id FROM api_tokens WHERE token_hash = ?").get(tokenHash);
  if (existing) {
    app.log.info("BOOTSTRAP_API_TOKEN 对应的 Token 已存在，跳过注入");
  } else {
    const admin = db
      .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (admin) {
      db.prepare(
        "INSERT INTO api_tokens (user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(admin.id, "BOOTSTRAP_API_TOKEN", tokenHash, JSON.stringify(["admin"]), new Date().toISOString());
      app.log.info({ userId: admin.id }, "已从 BOOTSTRAP_API_TOKEN 注入管理员 Token");
    } else {
      app.log.warn("设置了 BOOTSTRAP_API_TOKEN，但还没有管理员账号：先访问 /setup 初始化后再重启容器");
    }
  }
}

app
  .listen({ port: config.httpPort, host: config.host })
  .then((address) => {
    app.log.info(`NekoShelf ${config.version} listening on ${address} (DATA_MODE=${config.dataMode})`);
    if (!config.scanOnStart) return;
    // 启动自动扫描：容器化部署没有浏览器可点「扫描」，用 SCAN_ON_START 兜底
    setImmediate(() => {
      void (async () => {
        for (const library of listLibraries(db)) {
          const jobId = randomUUID();
          createJob(db, { id: jobId, type: "scan", libraryId: library.id });
          try {
            const summary = await scanLibrary(db, library, {
              jobId,
              delayMs: config.scanDelayMs,
              readComicInfo: true,
              unmatchedVideoPolicy: config.unmatchedVideoPolicy,
            });
            app.log.info({ summary }, `启动扫描完成：${library.name}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            updateJob(db, jobId, { state: "failed", message });
            app.log.error({ error }, `启动扫描失败：${library.name}`);
          }
        }
      })();
    });
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`收到 ${signal}，正在关闭`);
    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}
