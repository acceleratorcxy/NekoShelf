import { parseAvFilename } from "./avCode.js";
import { parseGidDirectory } from "./gid.js";
import { parsePageDeclaration } from "./pageDecl.js";
import { parseNameTags } from "./tags.js";
import type { ContentKind, MediaNameParse } from "./types.js";

/** 媒体文件扩展名。 */
export const IMAGE_EXTENSIONS = new Set([
  "webp",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "avif",
  "bmp",
]);

export const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mkv",
  "avi",
  "wmv",
  "mov",
  "ts",
  "m2ts",
  "webm",
  "flv",
  "rmvb",
  "mpg",
  "mpeg",
]);

export const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "cbz",
  "rar",
  "cbr",
  "7z",
  "cb7",
  "tar",
  "gz",
]);

/** 不作为媒体计数的文件。 */
export const NON_MEDIA_EXTENSIONS = new Set([
  "html",
  "htm",
  "txt",
  "docx",
  "doc",
  "pdf",
  "epub",
  "json",
  "xml",
  "cfg",
  "url",
  "lnk",
  "db",
  "sqlite",
]);

/**
 * 下载中文件的临时命名。`.pptd` 是网盘客户端常见的下载中间态，
 * 同名 `.cfg` 是它的伴生配置；命中一律跳过，绝不入库。
 */
const DOWNLOAD_TEMP_RE = /(\.pptd|\.part|\.downloading|\.aria2|\.!qb|\.tmp|\.crdownload)$/i;

export function isDownloadTemp(name: string): boolean {
  return DOWNLOAD_TEMP_RE.test(name);
}

/** 同名伴生配置：`xxx.zip.pptd.cfg`、`xxx.cfg`。 */
export function isDownloadCompanion(name: string): boolean {
  return /(\.(pptd|part|downloading))?\.cfg$/i.test(name);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(name));
}

export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}

/** 由扩展名 + 声明猜内容种类；目录的真实种类由扫描器看内部文件决定。 */
export function guessKindFromName(name: string): ContentKind {
  if (isImageFile(name)) return "image-set";
  if (isVideoFile(name)) return "video";
  if (isArchiveFile(name)) return "archive";
  return "unknown";
}

/**
 * 目录名聚合解析：目录名可能是 `{gid}-{title}`（EhViewer）、
 * `作者 - NO.01 牛仔裤 [23P-164MB]`（套图）、`[某合集] xxx`（视频包）等。
 */
export function parseMediaFilename(
  name: string,
  options: { isDirectory: boolean },
): MediaNameParse {
  const gidDirectory = options.isDirectory ? parseGidDirectory(name) : null;
  const pageDeclaration = parsePageDeclaration(name);

  // 番号只在「像视频的条目」上解析：目录名里的 `C104` 这类活动标记不应被当成 AV 番号
  const looksLikeVideo =
    !options.isDirectory && isVideoFile(name) ? true : false;
  const av = looksLikeVideo ? parseAvFilename(name) : null;

  return {
    raw: name,
    kind: gidDirectory ? "comic" : guessKindFromName(name),
    gidDirectory,
    pageDeclaration,
    av,
    tags: parseNameTags(name),
  };
}
