#!/usr/bin/env node
/**
 * NekoShelf 命令行（容器内无浏览器时用）：
 *
 *   nekoshelf health                 # 数据库/版本自检
 *   nekoshelf libraries              # 列出媒体库
 *   nekoshelf scan [--library <id|name>]   # 立即扫描（等同设置页点「扫描」）
 *   nekoshelf jobs                   # 最近任务
 *   nekoshelf tokens                 # 列出客户端 Token
 *   nekoshelf token:create --name <名字> [--scopes read,write,admin]
 *   nekoshelf token:revoke <id>
 */
import { randomUUID } from "node:crypto";
import {
  countWorksInLibrary,
  createJob,
  findLibrary,
  listJobs,
  listLibraries,
  openDatabase,
  scanLibrary,
} from "@nekoshelf/core";
import { issueApiToken, parseStoredScopes, tokenPrefix, type ApiTokenRow } from "./auth.js";
import { dbPath, loadConfig } from "./config.js";

const config = loadConfig();
const db = openDatabase({ path: dbPath(config) });

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  switch (command) {
    case "health": {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      printJson({
        ok: true,
        version: config.version,
        schemaVersion: version,
        dataMode: config.dataMode,
        dbPath: dbPath(config),
        users,
        libraries: listLibraries(db).length,
      });
      return;
    }

    case "libraries": {
      printJson(
        listLibraries(db).map((library) => ({
          id: library.id,
          name: library.name,
          rootPath: library.root_path,
          kind: library.kind,
          workCount: countWorksInLibrary(db, library.id),
          lastScanAt: library.last_scan_at,
        })),
      );
      return;
    }

    case "jobs": {
      printJson(
        listJobs(db, 20).map((job) => ({
          id: job.id,
          type: job.type,
          state: job.state,
          message: job.message,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
        })),
      );
      return;
    }

    case "scan": {
      const target = arg("library");
      const libraries = listLibraries(db);
      if (libraries.length === 0) {
        process.stderr.write("还没有媒体库：先启动服务，在 /setup 或设置页添加媒体库。\n");
        process.exitCode = 1;
        return;
      }
      const selected =
        target === undefined
          ? libraries
          : libraries.filter(
              (library) => String(library.id) === target || library.name.toLowerCase() === target.toLowerCase(),
            );
      if (selected.length === 0) {
        process.stderr.write(`找不到媒体库：${target}\n`);
        process.exitCode = 1;
        return;
      }
      for (const library of selected) {
        const jobId = randomUUID();
        createJob(db, { id: jobId, type: "scan", libraryId: library.id });
        process.stderr.write(`扫描 ${library.name} (${library.root_path}) …\n`);
        const summary = await scanLibrary(db, library, {
          jobId,
          delayMs: config.scanDelayMs,
          readComicInfo: true,
          unmatchedVideoPolicy: config.unmatchedVideoPolicy,
        });
        printJson({ library: library.name, ...summary });
      }
      return;
    }

    case "tokens": {
      const rows = db
        .prepare("SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY id DESC")
        .all() as unknown as ApiTokenRow[];
      printJson(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: tokenPrefix(row.token_hash),
          scopes: parseStoredScopes(row.scopes),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })),
      );
      return;
    }

    case "token:create": {
      const name = arg("name")?.trim() || "cli";
      const scopes = (arg("scopes") ?? "read").split(",").map((scope) => scope.trim()).filter(Boolean);
      const allowed = new Set(["read", "write", "admin"]);
      const invalid = scopes.filter((scope) => !allowed.has(scope));
      if (invalid.length > 0) {
        process.stderr.write(`未知作用域：${invalid.join(", ")}（可选 read/write/admin）\n`);
        process.exitCode = 1;
        return;
      }
      const admin = db
        .prepare("SELECT id, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
        .get() as { id: number; username: string } | undefined;
      if (!admin) {
        process.stderr.write("还没有管理员账号：先访问 /setup 初始化。\n");
        process.exitCode = 1;
        return;
      }
      const issued = issueApiToken();
      db.prepare(
        "INSERT INTO api_tokens (user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(admin.id, name, issued.tokenHash, JSON.stringify(scopes), new Date().toISOString());
      process.stderr.write(`已为 ${admin.username} 创建 Token「${name}」，作用域：${scopes.join(",")}\n`);
      process.stderr.write("明文只显示这一次，请立刻保存：\n");
      process.stdout.write(`${issued.token}\n`);
      return;
    }

    case "token:revoke": {
      const id = Number(process.argv[3]);
      const result = db
        .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), id);
      if (result.changes === 0) {
        process.stderr.write(`没有找到可吊销的 Token：${id}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`已吊销 Token ${id}\n`);
      return;
    }

    default: {
      process.stdout.write(
        [
          "NekoShelf 命令行",
          "",
          "  nekoshelf health",
          "  nekoshelf libraries",
          "  nekoshelf scan [--library <id|name>]",
          "  nekoshelf jobs",
          "  nekoshelf tokens",
          "  nekoshelf token:create --name <名字> [--scopes read,write,admin]",
          "  nekoshelf token:revoke <id>",
          "",
        ].join("\n"),
      );
      if (command !== undefined && command !== "help" && command !== "--help") process.exitCode = 1;
    }
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
