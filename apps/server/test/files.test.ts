/**
 * 库内原始文件读取（文件树预览）：只读、防穿越、缩略图与视频 Range。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, type Db } from "@nekoshelf/core";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// 1x1 PNG
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("library file route", () => {
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let db: Db;
  let cookie: string;
  let dir: string;
  let libraryId: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-files-"));
    const root = join(dir, "media");
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "001.png"), PNG_BYTES);
    await writeFile(join(root, "a", "clip.mp4"), Buffer.alloc(2048, 7));
    await writeFile(join(dir, "secret.txt"), "secret");
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
    libraryId = createLibrary(db, { name: "媒体库", rootPath: root }).id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function get(url: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url, headers: { cookie, ...headers } });
  }

  it("读取图片并与缩略图接口", async () => {
    const raw = await get(`/api/libraries/${libraryId}/file?path=a/001.png`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("image/png");
    expect(raw.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    const thumb = await get(`/api/libraries/${libraryId}/file?path=a/001.png&thumb=1&w=64`);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.rawPayload.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("拒绝路径穿越与目录", async () => {
    const escape = await get(`/api/libraries/${libraryId}/file?path=../secret.txt`);
    expect([400, 404]).toContain(escape.statusCode);
    const dirReq = await get(`/api/libraries/${libraryId}/file?path=a`);
    expect(dirReq.statusCode).toBe(400);
  });

  it("视频支持 Range", async () => {
    const res = await get(`/api/libraries/${libraryId}/file?path=a/clip.mp4`, {
      range: "bytes=10-19",
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 10-19/2048");
    expect(res.headers["content-length"]).toBe("10");
  });
});
