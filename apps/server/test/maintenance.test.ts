/**
 * 维护 / 备份路由集成测试：临时 CONFIG_DIR，验证在线快照与列表。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("maintenance routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-maint-"));
    const config = loadConfig({
      CONFIG_DIR: join(dir, "config"),
      CACHE_DIR: join(dir, "cache"),
    });
    ({ app, db } = await createApp(config));
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { username: "admin", password: "testpass123" },
    });
    const sid = setup.cookies.find((item) => item.name === "sid")?.value;
    cookie = `sid=${sid}`;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function inject(method: "GET" | "POST", url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { cookie }, payload: payload as object });
  }

  it("维护信息可读且初始无备份", async () => {
    const res = await inject("GET", "/api/maintenance");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      maintenance: { version: string; configDir: string; backupCount: number; backups: unknown[] };
    };
    expect(body.maintenance.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.maintenance.backupCount).toBe(0);
    expect(body.maintenance.backups).toEqual([]);
  });

  it("在线备份生成快照并可被列出", async () => {
    const res = await inject("POST", "/api/maintenance/backup");
    expect(res.statusCode).toBe(200);
    const created = res.json() as { backup: { name: string; bytes: number } };
    expect(created.backup.name).toMatch(/^nekoshelf-.*\.db$/);
    expect(created.backup.bytes).toBeGreaterThan(0);

    const info = await inject("GET", "/api/maintenance");
    const body = info.json() as { maintenance: { backupCount: number; backups: Array<{ name: string }> } };
    expect(body.maintenance.backupCount).toBe(1);
    expect(body.maintenance.backups[0]?.name).toBe(created.backup.name);
  });
});
