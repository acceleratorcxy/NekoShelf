import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import sharp from "sharp";
import type { Db, WorkRow } from "@nekoshelf/core";
import {
  detectArchiveKind,
  findLibrary,
  findWorkPage,
  listWorkPageRows,
  listWorkPages,
  looksLikeCoverImage,
  readArchiveContent,
} from "@nekoshelf/core";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 拼接路径并强制其位于根目录内（防路径穿越，）。 */
export function safeJoin(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HttpError(400, "validation_failed", "路径越界");
  }
  return target;
}

export function workAbsolutePath(db: Db, work: WorkRow): string {
  const library = findLibrary(db, work.library_id);
  if (!library) throw new HttpError(404, "not_found", "媒体库不存在");
  return safeJoin(library.root_path, work.path);
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export interface PageContent {
  name: string;
  buffer: Buffer;
}

/* ---------------- 内存页缓存 ---------------- */

const PAGE_CACHE_BUDGET = Math.max(
  16,
  Number(process.env.PAGE_CACHE_MB ?? 96),
) * 1024 * 1024;
const pageCache = new Map<string, Buffer>();
let pageCacheBytes = 0;

function pageCacheKey(work: WorkRow, pageName: string): string {
  return `${work.id}:${work.mtime ?? 0}:${pageName}`;
}

function pageCacheGet(key: string): Buffer | undefined {
  const hit = pageCache.get(key);
  if (hit) {
    // 命中后移到队尾（LRU）
    pageCache.delete(key);
    pageCache.set(key, hit);
  }
  return hit;
}

function pageCacheSet(key: string, buffer: Buffer): void {
  if (buffer.length > PAGE_CACHE_BUDGET / 4) return;
  const existing = pageCache.get(key);
  if (existing) pageCacheBytes -= existing.length;
  pageCache.set(key, buffer);
  pageCacheBytes += buffer.length;
  while (pageCacheBytes > PAGE_CACHE_BUDGET && pageCache.size > 1) {
    const oldest = pageCache.keys().next();
    if (oldest.done) break;
    const value = pageCache.get(oldest.value);
    pageCache.delete(oldest.value);
    if (value) pageCacheBytes -= value.length;
  }
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v"]);

function isVideoName(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(name).slice(1).toLowerCase());
}

/** 读取作品第 index 页（从 1 开始）的原始字节。 */
export async function readPageContent(
  db: Db,
  work: WorkRow,
  index: number,
  cacheDir?: string,
): Promise<PageContent> {
  const page = findWorkPage(db, work.id, index);
  if (!page) throw new HttpError(404, "not_found", "页不存在");

  if (work.source_kind === "directory") {
    const workPath = workAbsolutePath(db, work);
    const filePath = safeJoin(workPath, page.name);
    return { name: page.name, buffer: await readFile(filePath) };
  }

  if (work.source_kind === "archive") {
    const archivePath = workAbsolutePath(db, work);
    try {
      const kind = await detectArchiveKind(archivePath);
      const key = pageCacheKey(work, page.name);
      // zip 可在中央目录随机 seek 直读，直接流式取单页
      if (kind === "zip" || (cacheDir === undefined && !isVideoName(page.name))) {
        const cached = pageCacheGet(key);
        if (cached) return { name: page.name, buffer: cached };
        const buffer = await readArchiveContent(archivePath, page.name);
        pageCacheSet(key, buffer);
        return { name: page.name, buffer };
      }
      // 7z/rar 的图片单页：tttar/7z 解出后只放内存，刷新 LRU
      if (!isVideoName(page.name)) {
        const cached = pageCacheGet(key);
        if (cached) return { name: page.name, buffer: cached };
        const buffer = await readArchiveContent(archivePath, page.name);
        pageCacheSet(key, buffer);
        return { name: page.name, buffer };
      }
      // 归档内视频：体积大，仍走 /cache 磁盘缓存
      if (cacheDir === undefined) {
        return { name: page.name, buffer: await readArchiveContent(archivePath, page.name) };
      }
      const digest = createHash("sha1").update(page.name).digest("hex").slice(0, 16);
      const ext = extname(page.name).toLowerCase() || ".bin";
      const cachePath = join(
        cacheDir,
        "archives",
        `${work.id}-${work.mtime ?? 0}-${digest}${ext}`,
      );
      try {
        return { name: page.name, buffer: await readFile(cachePath) };
      } catch {
        // miss：解压后写缓存
      }
      const buffer = await readArchiveContent(archivePath, page.name);
      await mkdir(join(cacheDir, "archives"), { recursive: true });
      await writeFile(cachePath, buffer);
      return { name: page.name, buffer };
    } catch (error) {
      throw new HttpError(404, "not_found", error instanceof Error ? error.message : "读取失败");
    }
  }

  // 视频作品：单页即整段视频文件。
  const videoPath = workAbsolutePath(db, work);
  return { name: work.path, buffer: await readFile(videoPath) };
}

/** 打开视频文件流（支持 Range，供 <video> 播放）。 */
export function openVideoStream(db: Db, work: WorkRow): { stream: NodeJS.ReadableStream; size: number } {
  const videoPath = workAbsolutePath(db, work);
  return { stream: createReadStream(videoPath), size: 0 };
}

export async function videoStat(db: Db, work: WorkRow): Promise<{ size: number }> {
  const videoPath = workAbsolutePath(db, work);
  const info = await stat(videoPath);
  return { size: info.size };
}

/** 缩略图结果：解码不了的格式会回退为原图字节。 */
export interface Thumbnail {
  buffer: Buffer;
  contentType: string;
}

/** 图片解码失败时的兜底：尽量把「扩展名与实际格式不符」的图片转成浏览器能显示的 JPEG。 */
async function renderThumbnail(content: PageContent, size: number, format: "webp" | "jpeg"): Promise<Buffer> {
  const pipeline = sharp(content.buffer, { failOn: "none" })
    .rotate()
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true });
  return format === "webp"
    ? pipeline.webp({ quality: 78 }).toBuffer()
    : pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/**
 * 缩略图：webp，长边 320，落 /cache/thumbs，mtime 失效后重算。
 * 遇到 HEIF/AVIF 等以 .jpg 伪装的图片时回退为 JPEG，仍失败则直接返回原始字节，
 * 不让「单张图片解不了」变成整个封面/缩略图接口 500。
 */
export async function thumbnailBuffer(
  db: Db,
  work: WorkRow,
  index: number,
  cacheDir: string,
  size = 320,
): Promise<Thumbnail> {
  const thumbsDir = join(cacheDir, "thumbs");
  const stamp =
    createHash("sha1")
      .update(String(work.fingerprint ?? work.updated_at))
      .digest("hex")
      .slice(0, 10) || "x";
  const webpPath = join(thumbsDir, `${work.id}-${index}-${size}-${stamp}.webp`);
  try {
    return { buffer: await readFile(webpPath), contentType: "image/webp" };
  } catch {
    // miss：下面生成
  }
  const jpegPath = join(thumbsDir, `${work.id}-${index}-${size}-${stamp}.jpg`);
  try {
    return { buffer: await readFile(jpegPath), contentType: "image/jpeg" };
  } catch {
    // miss：下面生成
  }

  const content = await readPageContent(db, work, index);
  await mkdir(thumbsDir, { recursive: true });
  try {
    const buffer = await renderThumbnail(content, size, "webp");
    await writeFile(webpPath, buffer);
    return { buffer, contentType: "image/webp" };
  } catch {
    // 继续尝试 JPEG
  }
  try {
    const buffer = await renderThumbnail(content, size, "jpeg");
    await writeFile(jpegPath, buffer);
    return { buffer, contentType: "image/jpeg" };
  } catch {
    return { buffer: content.buffer, contentType: contentTypeFor(content.name) };
  }
}

const BMFF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);

/** 页面字节是否为 HEIF/AVIF 容器（常见于把 .heic 改名成 .jpg 的样本）。 */
function looksLikeHeif(buffer: Buffer): boolean {
  if (buffer.length < 12 || buffer.toString("latin1", 4, 8) !== "ftyp") return false;
  return BMFF_BRANDS.has(buffer.toString("latin1", 8, 12));
}

/** 阅读器页图：浏览器不支持 HEIF/AVIF 时转成 JPEG 再发。 */
export async function pageImageForBrowser(content: PageContent): Promise<PageContent & { contentType: string }> {
  if (!looksLikeHeif(content.buffer)) {
    return { ...content, contentType: contentTypeFor(content.name) };
  }
  try {
    const buffer = await sharp(content.buffer, { failOn: "none" }).rotate().jpeg({ quality: 90 }).toBuffer();
    return { name: `${content.name}.jpg`, buffer, contentType: "image/jpeg" };
  } catch {
    return { ...content, contentType: "image/jpeg" };
  }
}

/** 目录作品的页名列表来自数据库；用于详情接口校验。 */
export async function directoryPageNames(db: Db, work: WorkRow): Promise<string[]> {
  return listWorkPages(db, work.id).map((page) => page.name);
}

/** 清理作品缓存（删除作品时调用）。 */
export async function clearWorkCache(workId: number, cacheDir: string): Promise<void> {
  const thumbsDir = join(cacheDir, "thumbs");
  let entries: string[] = [];
  try {
    entries = await readdir(thumbsDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${workId}-`))
      .map((name) => rm(join(thumbsDir, name), { force: true })),
  );
}

/**
 * 封面页选择：优先 `cover.jpg`/`folder.png` 这类显式封面，否则第一页。
 * 目录与压缩包同样适用。
 */
export function resolveCoverIndex(db: Db, work: WorkRow): number | null {
  // 只看最前面 3 页：合集/大压缩包里更靠后的「xxx_cover.jpg」往往属于里面另一本书，
  // 以前全表 find 会把封面取成别的作品的内页，导致封面与内容错乱。
  const pages = listWorkPageRows(db, work.id, 3);
  if (pages.length === 0) return null;
  const explicit = pages.find((page) => looksLikeCoverImage(page.name.split("/").pop() ?? page.name));
  return (explicit ?? pages[0]!).ordinal;
}

/** 视频封面：用 ffmpeg 抽一帧 JPEG（缓存到 /cache/posters）。不可用时返回 null。 */
export async function videoPosterBuffer(
  db: Db,
  work: WorkRow,
  cacheDir: string,
  width = 640,
  sourceOverride?: string,
): Promise<Buffer | null> {
  const source = sourceOverride ?? workAbsolutePath(db, work);
  const cacheKey = createHash("sha1").update(source).digest("hex").slice(0, 10);
  const cachePath = join(cacheDir, "posters", `${work.id}-${cacheKey}.jpg`);
  try {
    return await readFile(cachePath);
  } catch {
    // miss
  }
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const grab = (seekSeconds: string): Promise<Buffer> =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          seekSeconds,
          "-i",
          source,
          "-frames:v",
          "1",
          "-vf",
          `scale=${width}:-2`,
          "-f",
          "image2",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => rejectPromise(error));
      child.on("close", (code) => {
        if (code === 0 && chunks.length > 0) resolvePromise(Buffer.concat(chunks));
        else rejectPromise(new Error(stderr || `ffmpeg 退出码 ${code}`));
      });
    });

  let buffer: Buffer | null = null;
  for (const seek of ["10", "1", "0"]) {
    buffer = await grab(seek).catch(() => null);
    if (buffer) break;
  }
  if (!buffer) return null;
  await mkdir(join(cacheDir, "posters"), { recursive: true });
  await writeFile(cachePath, buffer);
  return buffer;
}
