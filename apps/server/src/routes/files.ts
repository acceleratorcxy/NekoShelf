/**
 * 库内原始文件读取（文件树浏览用，只读）。
 *
 * 仅允许读取「库根目录之下」的普通文件；用于在文件树里直接预览图片、播放视频。
 * - `?thumb=1&w=480`：图片缩略图（sharp 转 WebP，缓存到 /cache/tree-thumbs）。
 * - 视频支持 HTTP Range（拖动进度条）。
 */
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import { safeJoin } from "../media.js";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".jxl": "image/jxl",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
  ".rmvb": "video/vnd.rn-realvideo",
  ".wmv": "video/x-ms-wmv",
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".jxl"]);

function normalizeRel(value: string): string {
  const trimmed = (value ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("path traversal");
  return parts.join("/");
}

/** 解析 `bytes=start-end`，返回闭区间 [start, end]；不合法返回 null。 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function registerFileRoutes(app: FastifyInstance, config: AppConfig, findLibrary: (id: number) => { id: number; root_path: string } | undefined): void {
  app.get("/api/libraries/:id/file", async (request, reply) => {
    const library = findLibrary(Number((request.params as { id: string }).id));
    if (!library) {
      return reply.code(404).send({ error: { code: "not_found", message: "媒体库不存在" } });
    }
    const query = request.query as { path?: string; thumb?: string; w?: string };
    let rel: string;
    try {
      rel = normalizeRel(query.path ?? "");
    } catch {
      return reply.code(400).send({ error: { code: "validation_failed", message: "路径非法" } });
    }
    if (!rel) {
      return reply.code(400).send({ error: { code: "validation_failed", message: "缺少文件路径" } });
    }

    const absolute = safeJoin(library.root_path, rel);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      return reply.code(404).send({ error: { code: "file_not_found", message: "文件不存在" } });
    }
    if (!info.isFile()) {
      return reply.code(400).send({ error: { code: "not_a_file", message: "不是文件" } });
    }

    const ext = extname(absolute).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      return reply.code(415).send({ error: { code: "unsupported_media", message: "不支持预览该类型文件" } });
    }

    const wantsThumb = query.thumb === "1" || query.thumb === "true";
    if (wantsThumb) {
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return reply.code(415).send({ error: { code: "unsupported_media", message: "该文件不支持缩略图" } });
      }
      const width = Math.min(Math.max(Number(query.w ?? 480) || 480, 120), 1600);
      const cacheDir = join(config.cacheDir, "tree-thumbs");
      const key = createHash("sha1").update(`${rel}:${info.size}:${info.mtimeMs}:${width}`).digest("hex");
      const cachePath = join(cacheDir, `${key}.webp`);
      let body: Buffer;
      try {
        body = await readFile(cachePath);
      } catch {
        try {
          body = await sharp(absolute, { failOn: "none" })
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
        } catch {
          return reply.code(415).send({ error: { code: "thumbnail_failed", message: "缩略图生成失败" } });
        }
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cachePath, body).catch(() => undefined);
      }
      return reply
        .header("content-type", "image/webp")
        .header("content-length", String(body.byteLength))
        .header("cache-control", "private, max-age=86400")
        .send(body);
    }

    const range = parseRange(request.headers.range, info.size);
    const commonHeaders = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "last-modified": info.mtime.toUTCString(),
    };
    if (range) {
      const chunkSize = range.end - range.start + 1;
      return reply
        .code(206)
        .headers({
          ...commonHeaders,
          "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
          "content-length": String(chunkSize),
        })
        .send(createReadStream(absolute, { start: range.start, end: range.end }));
    }
    return reply
      .headers({ ...commonHeaders, "content-length": String(info.size) })
      .send(createReadStream(absolute));
  });
}
